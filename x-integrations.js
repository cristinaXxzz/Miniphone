(function () {
  "use strict";

  const MUSIC_CFG_KEY = "x_netease_music_cfg_v1";
  const VECTOR_CFG_KEY = "x_vector_embedding_cfg_v1";
  const VECTOR_DB_NAME = "MiniphoneXVectorDB";
  const VECTOR_DB_VERSION = 1;
  const DEFAULT_MUSIC_CFG = {
    workerUrl: "https://sullyos-worker.cristinazhou0122.workers.dev",
    cookie: "",
    quality: "exhigh",
  };
  const DEFAULT_VECTOR_CFG = {
    baseUrl: "",
    apiKey: "",
    model: "BAAI/bge-m3",
    dimensions: 1024,
  };
  const MEMORY_CHUNK_SIZE = 70;
  const MEMORY_ROOMS = {
    living_room: "客厅 - 日常闲聊、近期互动",
    bedroom: "卧室 - 亲密情感、深层羁绊",
    study: "书房 - 工作学习、技能成长",
    user_room: "用户房间 - 用户个人信息、习惯",
    self_room: "自我房间 - 角色自我认同、变化",
    trauma_room: "创伤房间 - 伤害、恐惧、冲突与保护性记忆",
    attic: "阁楼 - 未消化的困惑、潜意识",
    windowsill: "窗台 - 期盼、目标、憧憬",
  };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function normalizeCookie(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    return value.toUpperCase().startsWith("MUSIC_U=")
      ? value
      : `MUSIC_U=${value}`;
  }

  function toHttps(url) {
    if (!url || typeof url !== "string") return url || "";
    return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
  }

  function getArtists(song) {
    const list = song?.ar || song?.artists || [];
    if (Array.isArray(list) && list.length) {
      return list.map((item) => item.name).filter(Boolean).join(" / ");
    }
    return song?.artist || song?.artists || "未知歌手";
  }

  function getAlbum(song) {
    return song?.al || song?.album || {};
  }

  function compactSong(song) {
    const album = getAlbum(song);
    return {
      id: Number(song.id),
      name: song.name || "未知歌曲",
      artist: getArtists(song),
      album: album.name || "",
      cover: toHttps(album.picUrl || album.artist?.picUrl || ""),
      duration: Number(song.dt || song.duration || 0),
      raw: song,
    };
  }

  const XMusic = {
    loadCfg() {
      return readJson(MUSIC_CFG_KEY, DEFAULT_MUSIC_CFG);
    },

    saveCfg(cfg) {
      const next = {
        ...DEFAULT_MUSIC_CFG,
        ...cfg,
        workerUrl: String(cfg.workerUrl || DEFAULT_MUSIC_CFG.workerUrl).trim(),
        cookie: normalizeCookie(cfg.cookie || ""),
      };
      writeJson(MUSIC_CFG_KEY, next);
      return next;
    },

    async call(path, body = {}, cfg = XMusic.loadCfg()) {
      const base = String(cfg.workerUrl || "").replace(/\/+$/, "");
      if (!base) throw new Error("请先填写网易云 Worker 地址");
      const headers = { "Content-Type": "application/json" };
      const cookie = normalizeCookie(cfg.cookie);
      if (cookie) headers["X-Netease-Cookie"] = cookie;
      const url = `${base}/netease${path.startsWith("/") ? path : `/${path}`}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      }
      return data;
    },

    search(keyword, offset = 0, cfg) {
      return XMusic.call(
        "/search",
        { keyword, limit: 30, offset, type: 1 },
        cfg,
      );
    },

    songUrl(id, cfg) {
      const quality = cfg?.quality || XMusic.loadCfg().quality;
      return XMusic.call("/song/url", { ids: [Number(id)], level: quality }, cfg);
    },

    lyric(id, cfg) {
      return XMusic.call("/lyric", { id: Number(id) }, cfg);
    },

    loginStatus(cfg) {
      return XMusic.call("/login/status", {}, cfg);
    },

    loginQrKey(cfg) {
      return XMusic.call("/login/qr/key", {}, cfg);
    },

    loginQrCreate(key, cfg) {
      return XMusic.call("/login/qr/create", { key, qrimg: true }, cfg);
    },

    loginQrCheck(key, cfg) {
      return XMusic.call("/login/qr/check", { key }, cfg);
    },

    recommendSongs(cfg) {
      return XMusic.call("/recommend/songs", {}, cfg);
    },

    personalFm(cfg) {
      return XMusic.call("/personal_fm", {}, cfg);
    },

    userPlaylist(uid, cfg) {
      return XMusic.call("/user/playlist", { uid, limit: 60 }, cfg);
    },

    playlistTrackAll(id, cfg, limit = 50, offset = 0) {
      return XMusic.call("/playlist/track/all", { id, limit, offset }, cfg);
    },
  };

  function openVectorDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("memory_nodes")) {
          const nodes = db.createObjectStore("memory_nodes", { keyPath: "id" });
          nodes.createIndex("charId", "charId", { unique: false });
          nodes.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("memory_vectors")) {
          const vectors = db.createObjectStore("memory_vectors", {
            keyPath: "memoryId",
          });
          vectors.createIndex("charId", "charId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function getAllByIndex(db, storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function vectorToBytes(vector) {
    if (vector instanceof Uint8Array) return vector;
    const f32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
    return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  function vectorToFloat32(vector) {
    if (vector instanceof Float32Array) return vector;
    if (vector instanceof Uint8Array) {
      return new Float32Array(
        vector.buffer,
        vector.byteOffset,
        vector.byteLength / 4,
      );
    }
    return new Float32Array(vector || []);
  }

  function cosineSimilarity(a, b) {
    const left = vectorToFloat32(a);
    const right = vectorToFloat32(b);
    if (left.length !== right.length) {
      throw new Error(`向量维度不一致：${left.length} vs ${right.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < left.length; i++) {
      dot += left[i] * right[i];
      normA += left[i] * left[i];
      normB += right[i] * right[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom ? dot / denom : 0;
  }

  async function callEmbeddingAPI(texts, config) {
    const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
    if (!baseUrl || !config.apiKey || !config.model) {
      throw new Error("Embedding 配置缺少 baseUrl、apiKey 或 model");
    }
    const body = {
      model: config.model,
      input: texts,
      encoding_format: "float",
    };
    if (config.dimensions && /(^|\/)Qwen3-(?:VL-)?Embedding-/i.test(config.model)) {
      body.dimensions = Number(config.dimensions);
    }
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Embedding API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return [...(data.data || [])]
      .sort((a, b) => a.index - b.index)
      .map((item) => new Float32Array(item.embedding || []));
  }

  const XVectorStore = {
    cosineSimilarity,
    vectorToFloat32,

    async getEmbeddings(texts, config) {
      const clean = texts.map((text) => String(text || "").trim()).filter(Boolean);
      if (!clean.length) return [];
      const out = [];
      for (let i = 0; i < clean.length; i += 20) {
        out.push(...(await callEmbeddingAPI(clean.slice(i, i + 20), config)));
      }
      return out;
    },

    async saveMemory(memory) {
      const db = await openVectorDb();
      const now = Date.now();
      const node = {
        id:
          memory.id ||
          `xmem_${now}_${Math.random().toString(36).slice(2, 8)}`,
        charId: memory.charId || "global",
        content: String(memory.content || ""),
        tags: Array.isArray(memory.tags) ? memory.tags : [],
        room: memory.room || "living_room",
        importance: Number(memory.importance || 5),
        createdAt: memory.createdAt || now,
        updatedAt: now,
        metadata: memory.metadata || {},
      };
      const tx = db.transaction("memory_nodes", "readwrite");
      tx.objectStore("memory_nodes").put(node);
      await txDone(tx);
      return node;
    },

    async saveVector(memoryId, charId, vector, model) {
      const db = await openVectorDb();
      const f32 = vectorToFloat32(vector);
      const tx = db.transaction("memory_vectors", "readwrite");
      tx.objectStore("memory_vectors").put({
        memoryId,
        charId: charId || "global",
        vector: vectorToBytes(f32),
        dimensions: f32.length,
        model: model || "",
        updatedAt: Date.now(),
      });
      await txDone(tx);
    },

    async addMemory(memory, embeddingConfig) {
      const node = await XVectorStore.saveMemory(memory);
      if (embeddingConfig) {
        const [vector] = await XVectorStore.getEmbeddings(
          [node.content],
          embeddingConfig,
        );
        if (vector) {
          await XVectorStore.saveVector(
            node.id,
            node.charId,
            vector,
            embeddingConfig.model,
          );
        }
      }
      return node;
    },

    async listMemories(charId = "global") {
      const db = await openVectorDb();
      return getAllByIndex(db, "memory_nodes", "charId", charId);
    },

    async search(options) {
      const charId = options.charId || "global";
      const limit = Number(options.limit || 8);
      const [queryVector] = options.vector
        ? [vectorToFloat32(options.vector)]
        : await XVectorStore.getEmbeddings([options.query || ""], options.embeddingConfig);
      if (!queryVector) return [];

      const db = await openVectorDb();
      const [nodes, vectors] = await Promise.all([
        getAllByIndex(db, "memory_nodes", "charId", charId),
        getAllByIndex(db, "memory_vectors", "charId", charId),
      ]);
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));
      return vectors
        .map((item) => {
          const node = nodeMap.get(item.memoryId);
          if (!node) return null;
          return {
            node,
            score: cosineSimilarity(queryVector, item.vector),
            dimensions: item.dimensions,
            model: item.model,
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    async wipe(charId) {
      const db = await openVectorDb();
      const stores = ["memory_nodes", "memory_vectors"];
      for (const storeName of stores) {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        if (!charId) {
          store.clear();
        } else {
          const index = store.index("charId");
          const req = index.openKeyCursor(IDBKeyRange.only(charId));
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              store.delete(cursor.primaryKey);
              cursor.continue();
            }
          };
        }
        await txDone(tx);
      }
    },
  };

  function memoryProgressKey(chatId) {
    return `x_memory_last_index_${chatId || "global"}`;
  }

  function memoryEnabledKey(chatId) {
    return `x_memory_enabled_${chatId || "global"}`;
  }

  function isMemoryEnabled(chatId) {
    return localStorage.getItem(memoryEnabledKey(chatId)) !== "false";
  }

  function setMemoryEnabled(chatId, enabled) {
    localStorage.setItem(memoryEnabledKey(chatId), enabled ? "true" : "false");
  }

  function visibleChatMessages(chat) {
    return (chat?.history || []).filter(
      (msg) =>
        msg &&
        !msg.isHidden &&
        msg.type !== "summary" &&
        (msg.role === "user" || msg.role === "assistant" || msg.role === "system"),
    );
  }

  function formatMemoryMessage(msg, chat) {
    const time = msg.timestamp
      ? new Date(msg.timestamp).toLocaleString("zh-CN")
      : "";
    const sender =
      msg.role === "user"
        ? chat?.settings?.myNickname || "我"
        : msg.senderName || chat?.name || "角色";
    let content = "";
    if (Array.isArray(msg.content)) {
      content = "[图片/多模态消息]";
    } else if (msg.type === "sticker") {
      content = msg.meaning ? `[表情: ${msg.meaning}]` : "[表情]";
    } else if (msg.type === "voice_message") {
      content = `[语音] ${msg.content || ""}`;
    } else if (msg.type === "ai_image" || msg.type === "user_photo") {
      content = `[图片] ${msg.content || msg.description || ""}`;
    } else if (msg.type === "transfer") {
      content = `[转账] ${msg.amount || ""} ${msg.note || ""}`;
    } else if (msg.type === "pat_message") {
      content = `[系统事件] ${msg.content || ""}`;
    } else {
      content = String(msg.content || msg.message || "");
    }
    return `${time} ${sender}: ${content}`.trim();
  }

  function classifyRoom(text) {
    const t = String(text || "").toLowerCase();
    const tests = [
      ["trauma_room", /受伤|害怕|恐惧|背叛|吵架|崩溃|讨厌|痛苦|哭|拉黑|分手|失望|绝望|trauma|hurt|fear/],
      ["bedroom", /喜欢|爱你|想你|亲密|抱|吻|情侣|暧昧|心动|宝贝|晚安|想抱|love|miss/],
      ["study", /学习|工作|考试|项目|代码|计划|任务|资料|写作|作业|复习|研究|study|work|code/],
      ["user_room", /我喜欢|我讨厌|我的习惯|我的生日|我家|我的|用户|昵称|头像|住在|喜欢吃|不喜欢/],
      ["self_room", /你觉得|你想|你的过去|你的设定|人设|身份|你是谁|自我|角色|persona/],
      ["windowsill", /以后|未来|约定|期待|希望|梦想|想去|目标|下次|明天|生日|旅行|promise|future/],
      ["attic", /不知道|困惑|矛盾|奇怪|也许|可能|梦|隐约|说不清|confused|maybe/],
    ];
    const found = tests.find(([, re]) => re.test(t));
    return found ? found[0] : "living_room";
  }

  function localExtractMemories(chat, chunk, startIndex) {
    const text = chunk.map((msg) => formatMemoryMessage(msg, chat)).join("\n");
    const room = classifyRoom(text);
    const title = `${chat?.name || "聊天"}的第 ${startIndex + 1}-${startIndex + chunk.length} 条记录`;
    return [
      {
        content: `${title}\n${text}`.slice(0, 8000),
        room,
        tags: [chat?.name || "chat", "auto_chunk"],
        importance: room === "trauma_room" || room === "bedroom" ? 8 : 5,
      },
    ];
  }

  function parseJsonArrayLoose(text) {
    const raw = String(text || "")
      .replace(/^```json\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const first = raw.indexOf("[");
    const last = raw.lastIndexOf("]");
    if (first === -1 || last <= first) return null;
    return JSON.parse(raw.slice(first, last + 1));
  }

  async function callChatModelForMemory(prompt) {
    const cfg = window.state?.apiConfig || {};
    if (!cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      throw new Error("主聊天 API 未配置");
    }
    const apiKey =
      typeof window.getRandomValue === "function"
        ? window.getRandomValue(cfg.apiKey)
        : String(cfg.apiKey).split(/[,，\n]/)[0].trim();
    if (/generativelanguage\.googleapis\.com|gemini/i.test(cfg.proxyUrl)) {
      throw new Error("Gemini 记忆提炼暂走本地提取");
    }
    const res = await fetch(`${cfg.proxyUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`记忆提取 API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "";
  }

  async function extractMemories(chat, chunk, startIndex) {
    const text = chunk.map((msg) => formatMemoryMessage(msg, chat)).join("\n");
    const roomList = Object.entries(MEMORY_ROOMS)
      .map(([key, label]) => `- ${key}: ${label}`)
      .join("\n");
    const prompt = `你要把下面一段聊天记录提炼成长期记忆，并按房间分类。

房间只能从这些 key 里选：
${roomList}

要求：
- 输出严格 JSON 数组，不要 Markdown。
- 每条记忆格式：{"content":"第三人称/事实性记忆，保留人物、事件、情绪和重要细节","room":"living_room","tags":["短标签"],"importance":1-10}
- 只保留以后聊天真的有用的内容，最多 8 条。
- 如果内容很普通，也至少输出 1 条概括性记忆。

聊天记录：
${text}`;
    try {
      const response = await callChatModelForMemory(prompt);
      const parsed = parseJsonArrayLoose(response);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .map((item) => ({
            content: String(item.content || "").trim(),
            room: MEMORY_ROOMS[item.room] ? item.room : classifyRoom(item.content),
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
            importance: Math.max(1, Math.min(10, Number(item.importance || 5))),
          }))
          .filter((item) => item.content);
      }
    } catch (error) {
      console.warn("[XMemoryPalace] LLM extraction failed, fallback local chunk", error);
    }
    return localExtractMemories(chat, chunk, startIndex);
  }

  function getEmbeddingCfgOrNull() {
    const cfg = loadVectorCfg();
    return cfg.baseUrl && cfg.apiKey && cfg.model ? cfg : null;
  }

  const XMemoryPalace = {
    rooms: MEMORY_ROOMS,
    chunkSize: MEMORY_CHUNK_SIZE,
    isEnabled: isMemoryEnabled,
    setEnabled: setMemoryEnabled,

    getProgress(chatId) {
      return Number(localStorage.getItem(memoryProgressKey(chatId)) || 0);
    },

    setProgress(chatId, index) {
      localStorage.setItem(memoryProgressKey(chatId), String(Math.max(0, index)));
    },

    async processChatIfNeeded(chat, options = {}) {
      if (!chat?.id || !isMemoryEnabled(chat.id)) return { processed: 0 };
      const messages = visibleChatMessages(chat);
      let cursor = options.fromIndex ?? XMemoryPalace.getProgress(chat.id);
      let processed = 0;
      const embeddingCfg = getEmbeddingCfgOrNull();

      while (messages.length - cursor >= MEMORY_CHUNK_SIZE) {
        const chunk = messages.slice(cursor, cursor + MEMORY_CHUNK_SIZE);
        const extracted = await extractMemories(chat, chunk, cursor);
        for (const item of extracted) {
          const node = await XVectorStore.addMemory(
            {
              charId: chat.id,
              content: item.content,
              room: item.room,
              tags: ["auto_memory", ...(item.tags || [])],
              importance: item.importance,
              metadata: {
                chatId: chat.id,
                chatName: chat.name,
                source: "chat_auto_70",
                startIndex: cursor,
                endIndex: cursor + chunk.length - 1,
                createdFromMessages: chunk.length,
              },
            },
            embeddingCfg || undefined,
          );
          if (!embeddingCfg) {
            console.warn("[XMemoryPalace] saved memory without vector; configure embedding to enable semantic recall", node.id);
          }
        }
        cursor += MEMORY_CHUNK_SIZE;
        XMemoryPalace.setProgress(chat.id, cursor);
        processed += chunk.length;
      }
      return { processed, cursor };
    },

    async buildContext(chat, queryText, limit = 6) {
      if (!chat?.id || !isMemoryEnabled(chat.id)) return "";
      const embeddingCfg = getEmbeddingCfgOrNull();
      let results = [];
      if (embeddingCfg && queryText) {
        try {
          results = await XVectorStore.search({
            charId: chat.id,
            query: queryText,
            embeddingConfig: embeddingCfg,
            limit,
          });
        } catch (error) {
          console.warn("[XMemoryPalace] vector recall failed, fallback latest", error);
        }
      }
      if (!results.length) {
        const all = await XVectorStore.listMemories(chat.id);
        results = all
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, limit)
          .map((node) => ({ node, score: null }));
      }
      if (!results.length) return "";
      const body = results
        .map((item, index) => {
          const node = item.node || item;
          const roomLabel = MEMORY_ROOMS[node.room] || node.room || "客厅";
          const score =
            typeof item.score === "number" ? `，相关度 ${item.score.toFixed(2)}` : "";
          return `${index + 1}. 【${roomLabel}${score}】${node.content}`;
        })
        .join("\n");
      return `\n\n# 向量记忆宫殿召回（长期记忆，按房间分类）\n${body}\n`;
    },
  };

  function ensurePanel() {
    let panel = document.getElementById("x-netease-panel");
    if (panel) return panel;

    const style = document.createElement("style");
    style.textContent = `
      #x-netease-panel {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(28, 22, 27, 0.34);
        backdrop-filter: blur(12px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #x-netease-panel.visible { display: flex; }
      .x-netease-card {
        width: min(420px, calc(100vw - 26px));
        max-height: min(720px, calc(100vh - 26px));
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: rgba(255, 250, 252, 0.96);
        border: 1px solid rgba(205, 141, 141, 0.38);
        border-radius: 18px;
        box-shadow: 0 24px 70px rgba(55, 31, 40, 0.25);
        color: #47353b;
      }
      .x-netease-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(205, 141, 141, 0.18);
      }
      .x-netease-header h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
      .x-netease-close {
        border: 0;
        background: rgba(205, 141, 141, 0.14);
        color: #8a5d66;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        font-size: 22px;
        cursor: pointer;
      }
      .x-netease-body {
        overflow: auto;
        padding: 14px 16px 18px;
      }
      .x-netease-row { display: grid; gap: 7px; margin-bottom: 12px; }
      .x-netease-row label { font-size: 12px; color: #8a6b72; }
      .x-netease-input, .x-netease-select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(205, 141, 141, 0.32);
        background: #fff;
        color: #47353b;
        border-radius: 10px;
        min-height: 38px;
        padding: 8px 10px;
        font-size: 14px;
      }
      .x-netease-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 14px;
      }
      .x-netease-btn {
        border: 0;
        border-radius: 999px;
        background: #cd8d8d;
        color: #fff;
        padding: 9px 12px;
        font-size: 13px;
        cursor: pointer;
      }
      .x-netease-btn.secondary {
        background: rgba(205, 141, 141, 0.14);
        color: #7c515a;
      }
      .x-netease-status {
        min-height: 20px;
        color: #8a6b72;
        font-size: 13px;
        margin-bottom: 10px;
      }
      .x-netease-results {
        display: grid;
        gap: 8px;
      }
      .x-netease-song {
        display: grid;
        grid-template-columns: 44px 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 8px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(205, 141, 141, 0.14);
      }
      .x-netease-song img {
        width: 44px;
        height: 44px;
        object-fit: cover;
        border-radius: 8px;
        background: #f3e5e8;
      }
      .x-netease-title {
        font-size: 14px;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .x-netease-artist {
        font-size: 12px;
        color: #947780;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .x-netease-add {
        border: 0;
        border-radius: 9px;
        padding: 8px 9px;
        background: #5f7665;
        color: #fff;
        cursor: pointer;
        white-space: nowrap;
      }
      .x-netease-qr {
        display: none;
        place-items: center;
        padding: 12px;
        margin-bottom: 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.68);
      }
      .x-netease-qr img { max-width: 190px; border-radius: 10px; }
    `;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "x-netease-panel";
    panel.innerHTML = `
      <div class="x-netease-card">
        <div class="x-netease-header">
          <h2>网易云音乐</h2>
          <button class="x-netease-close" type="button" title="关闭">×</button>
        </div>
        <div class="x-netease-body">
          <div class="x-netease-row">
            <label>Worker 地址</label>
            <input id="x-music-worker-url" class="x-netease-input" type="url" />
          </div>
          <div class="x-netease-row">
            <label>网易云 Cookie / MUSIC_U</label>
            <input id="x-music-cookie" class="x-netease-input" type="password" placeholder="可扫码登录，也可粘贴 MUSIC_U" />
          </div>
          <div class="x-netease-row">
            <label>音质</label>
            <select id="x-music-quality" class="x-netease-select">
              <option value="standard">standard</option>
              <option value="higher">higher</option>
              <option value="exhigh">exhigh</option>
              <option value="lossless">lossless</option>
              <option value="hires">hires</option>
            </select>
          </div>
          <div class="x-netease-actions">
            <button id="x-music-save" class="x-netease-btn" type="button">保存配置</button>
            <button id="x-music-test" class="x-netease-btn secondary" type="button">测试登录</button>
            <button id="x-music-qr" class="x-netease-btn secondary" type="button">扫码登录</button>
            <button id="x-music-open-player" class="x-netease-btn secondary" type="button">打开播放器</button>
            <button id="x-music-daily" class="x-netease-btn secondary" type="button">日推</button>
            <button id="x-music-fm" class="x-netease-btn secondary" type="button">私人 FM</button>
          </div>
          <div id="x-music-qr-box" class="x-netease-qr"></div>
          <div class="x-netease-row">
            <label>搜索歌曲</label>
            <input id="x-music-keyword" class="x-netease-input" type="search" placeholder="歌名 / 歌手" />
          </div>
          <div class="x-netease-actions">
            <button id="x-music-search" class="x-netease-btn" type="button">搜索</button>
          </div>
          <div id="x-music-status" class="x-netease-status"></div>
          <div id="x-music-results" class="x-netease-results"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    bindPanelEvents(panel);
    return panel;
  }

  function getPanelCfg() {
    return XMusic.saveCfg({
      workerUrl: document.getElementById("x-music-worker-url").value,
      cookie: document.getElementById("x-music-cookie").value,
      quality: document.getElementById("x-music-quality").value,
    });
  }

  function setStatus(message, isError = false) {
    const el = document.getElementById("x-music-status");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#d64f4f" : "#8a6b72";
  }

  function renderSongs(songs) {
    const box = document.getElementById("x-music-results");
    if (!box) return;
    if (!songs.length) {
      box.innerHTML = `<div class="x-netease-status">没有找到歌曲。</div>`;
      return;
    }
    box.innerHTML = "";
    songs.map(compactSong).forEach((song) => {
      const item = document.createElement("div");
      item.className = "x-netease-song";
      item.innerHTML = `
        <img src="${song.cover || "https://i.postimg.cc/pT2xKzPz/album-cover-placeholder.png"}" alt="" />
        <div>
          <div class="x-netease-title" title="${song.name}">${song.name}</div>
          <div class="x-netease-artist" title="${song.artist}">${song.artist}</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="x-netease-add" type="button" data-action="add">加入</button>
          <button class="x-netease-add" type="button" data-action="play" style="background:#cd8d8d;">播放</button>
        </div>
      `;
      item.querySelector('[data-action="add"]').addEventListener("click", () => addSong(song, false));
      item.querySelector('[data-action="play"]').addEventListener("click", () => addSong(song, true));
      box.appendChild(item);
    });
  }

  async function addSong(song, playNow) {
    const cfg = getPanelCfg();
    setStatus(`正在获取《${song.name}》播放链接...`);
    try {
      const [urlRes, lyricRes] = await Promise.all([
        XMusic.songUrl(song.id, cfg),
        XMusic.lyric(song.id, cfg).catch(() => null),
      ]);
      const url = urlRes?.data?.[0]?.url || urlRes?.data?.[0]?.freeTrialInfo?.start;
      if (!url) throw new Error("没有拿到可播放链接，可能需要 VIP 或地区不可用");
      const track = {
        name: song.name,
        artist: song.artist,
        src: toHttps(url),
        cover: song.cover,
        lrcContent: lyricRes?.lrc?.lyric || lyricRes?.klyric?.lyric || "",
        isLocal: false,
        source: "netease",
        apiProvider: "x-worker",
        songId: song.id,
        addedAt: Date.now(),
      };
      if (window.ephoneMusicBridge?.addTrack) {
        await window.ephoneMusicBridge.addTrack(track, { playNow });
      } else if (window.state?.musicState?.playlist) {
        window.state.musicState.playlist.push(track);
      } else {
        throw new Error("播放器还没准备好，请稍后再试");
      }
      setStatus(playNow ? `正在播放《${song.name}》` : `已加入《${song.name}》到一起听歌单`);
    } catch (error) {
      console.error("[XMusic] add song failed", error);
      setStatus(error.message || "添加失败", true);
    }
  }

  function extractSongsFromResult(data) {
    return (
      data?.result?.songs ||
      data?.data?.dailySongs ||
      data?.data ||
      data?.songs ||
      []
    );
  }

  function bindPanelEvents(panel) {
    panel.querySelector(".x-netease-close").addEventListener("click", () => {
      panel.classList.remove("visible");
    });
    panel.addEventListener("click", (event) => {
      if (event.target === panel) panel.classList.remove("visible");
    });

    document.getElementById("x-music-save").addEventListener("click", () => {
      getPanelCfg();
      setStatus("配置已保存");
    });

    document.getElementById("x-music-test").addEventListener("click", async () => {
      setStatus("正在测试登录状态...");
      try {
        const data = await XMusic.loginStatus(getPanelCfg());
        const profile = data?.data?.profile || data?.profile;
        setStatus(profile ? `已登录：${profile.nickname}` : "未登录或 Cookie 无效");
      } catch (error) {
        setStatus(error.message || "测试失败", true);
      }
    });

    document.getElementById("x-music-open-player").addEventListener("click", () => {
      if (window.ephoneMusicBridge?.openPlayer) {
        window.ephoneMusicBridge.openPlayer();
        setStatus("已打开桌面播放器。聊天页右上角的“一起听”也使用这份歌单。");
      } else {
        setStatus("播放器尚未初始化，请稍后再试", true);
      }
    });

    document.getElementById("x-music-search").addEventListener("click", async () => {
      const keyword = document.getElementById("x-music-keyword").value.trim();
      if (!keyword) return setStatus("请输入搜索关键词", true);
      setStatus("搜索中...");
      try {
        const data = await XMusic.search(keyword, 0, getPanelCfg());
        const songs = extractSongsFromResult(data);
        renderSongs(songs);
        setStatus(`找到 ${songs.length} 首歌`);
      } catch (error) {
        setStatus(error.message || "搜索失败", true);
      }
    });

    document.getElementById("x-music-keyword").addEventListener("keydown", (event) => {
      if (event.key === "Enter") document.getElementById("x-music-search").click();
    });

    document.getElementById("x-music-daily").addEventListener("click", async () => {
      setStatus("正在拉取日推...");
      try {
        const data = await XMusic.recommendSongs(getPanelCfg());
        const songs = extractSongsFromResult(data);
        renderSongs(songs);
        setStatus(`日推 ${songs.length} 首`);
      } catch (error) {
        setStatus(error.message || "日推失败，请确认已登录网易云", true);
      }
    });

    document.getElementById("x-music-fm").addEventListener("click", async () => {
      setStatus("正在拉取私人 FM...");
      try {
        const data = await XMusic.personalFm(getPanelCfg());
        const songs = extractSongsFromResult(data);
        renderSongs(songs);
        setStatus(`私人 FM ${songs.length} 首`);
      } catch (error) {
        setStatus(error.message || "私人 FM 失败，请确认已登录网易云", true);
      }
    });

    document.getElementById("x-music-qr").addEventListener("click", startQrLogin);
  }

  async function startQrLogin() {
    const cfg = getPanelCfg();
    const qrBox = document.getElementById("x-music-qr-box");
    qrBox.style.display = "grid";
    qrBox.textContent = "正在生成二维码...";
    setStatus("请用网易云 App 扫码登录");
    try {
      const keyData = await XMusic.loginQrKey(cfg);
      const key = keyData?.data?.unikey || keyData?.unikey;
      if (!key) throw new Error("没有拿到二维码 key");
      const qrData = await XMusic.loginQrCreate(key, cfg);
      const qrimg = qrData?.data?.qrimg || qrData?.qrimg;
      qrBox.innerHTML = qrimg
        ? `<img src="${qrimg}" alt="网易云登录二维码" />`
        : "二维码生成失败";

      let attempts = 0;
      const timer = setInterval(async () => {
        attempts += 1;
        if (attempts > 90 || !document.getElementById("x-netease-panel")?.classList.contains("visible")) {
          clearInterval(timer);
          return;
        }
        try {
          const result = await XMusic.loginQrCheck(key, cfg);
          const code = Number(result?.code || result?.data?.code);
          if (code === 803 || result?.cookie) {
            clearInterval(timer);
            const cookie = result.cookie || result?.data?.cookie || "";
            const next = XMusic.saveCfg({ ...cfg, cookie });
            document.getElementById("x-music-cookie").value = next.cookie;
            qrBox.textContent = "登录成功";
            setStatus("网易云登录成功");
          } else if (code === 800) {
            clearInterval(timer);
            setStatus("二维码已过期，请重新生成", true);
          } else if (code === 802) {
            setStatus("已扫码，请在手机上确认");
          }
        } catch (error) {
          clearInterval(timer);
          setStatus(error.message || "扫码登录失败", true);
        }
      }, 2000);
    } catch (error) {
      qrBox.textContent = "";
      setStatus(error.message || "扫码登录失败", true);
    }
  }

  function openMusicPanel() {
    const panel = ensurePanel();
    const cfg = XMusic.loadCfg();
    document.getElementById("x-music-worker-url").value = cfg.workerUrl;
    document.getElementById("x-music-cookie").value = cfg.cookie;
    document.getElementById("x-music-quality").value = cfg.quality;
    panel.classList.add("visible");
    setStatus("可搜索歌曲后加入现有“一起听”歌单");
  }

  function ensureVectorPanel() {
    let panel = document.getElementById("x-vector-panel");
    if (panel) return panel;
    ensurePanel();

    panel = document.createElement("div");
    panel.id = "x-vector-panel";
    panel.className = "x-vector-panel-shell";
    panel.style.cssText =
      "position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(28,22,27,.34);backdrop-filter:blur(12px);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
    panel.innerHTML = `
      <div class="x-netease-card">
        <div class="x-netease-header">
          <h2>向量库</h2>
          <button class="x-netease-close" type="button" title="关闭">×</button>
        </div>
        <div class="x-netease-body">
          <div class="x-netease-row">
            <label>Embedding Base URL</label>
            <input id="x-vector-base-url" class="x-netease-input" type="url" placeholder="https://api.siliconflow.cn/v1" />
          </div>
          <div class="x-netease-row">
            <label>Embedding API Key</label>
            <input id="x-vector-api-key" class="x-netease-input" type="password" />
          </div>
          <div class="x-netease-row">
            <label>模型</label>
            <input id="x-vector-model" class="x-netease-input" type="text" />
          </div>
          <div class="x-netease-row">
            <label>维度</label>
            <input id="x-vector-dimensions" class="x-netease-input" type="number" min="1" step="1" />
          </div>
          <div class="x-netease-row">
            <label>角色/分区 ID</label>
            <input id="x-vector-char-id" class="x-netease-input" type="text" value="global" />
          </div>
          <div class="x-netease-row">
            <label>写入内容</label>
            <textarea id="x-vector-content" class="x-netease-input" rows="3" placeholder="要存进向量库的一条记忆"></textarea>
          </div>
          <div class="x-netease-actions">
            <button id="x-vector-save-cfg" class="x-netease-btn secondary" type="button">保存配置</button>
            <button id="x-vector-add" class="x-netease-btn" type="button">写入并向量化</button>
          </div>
          <div class="x-netease-row">
            <label>语义搜索</label>
            <input id="x-vector-query" class="x-netease-input" type="search" placeholder="输入查询句子" />
          </div>
          <div class="x-netease-actions">
            <button id="x-vector-search" class="x-netease-btn" type="button">搜索</button>
            <button id="x-vector-list" class="x-netease-btn secondary" type="button">列出本分区</button>
          </div>
          <div id="x-vector-status" class="x-netease-status"></div>
          <div id="x-vector-results" class="x-netease-results"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    bindVectorPanelEvents(panel);
    return panel;
  }

  function loadVectorCfg() {
    return readJson(VECTOR_CFG_KEY, DEFAULT_VECTOR_CFG);
  }

  function saveVectorCfgFromPanel() {
    const cfg = {
      baseUrl: document.getElementById("x-vector-base-url").value.trim(),
      apiKey: document.getElementById("x-vector-api-key").value.trim(),
      model: document.getElementById("x-vector-model").value.trim(),
      dimensions: Number(document.getElementById("x-vector-dimensions").value || 0),
    };
    const next = { ...DEFAULT_VECTOR_CFG, ...cfg };
    writeJson(VECTOR_CFG_KEY, next);
    return next;
  }

  function setVectorStatus(message, isError = false) {
    const el = document.getElementById("x-vector-status");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#d64f4f" : "#8a6b72";
  }

  function renderVectorResults(items) {
    const box = document.getElementById("x-vector-results");
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<div class="x-netease-status">暂无结果。</div>`;
      return;
    }
    box.innerHTML = "";
    items.forEach((item) => {
      const node = item.node || item;
      const row = document.createElement("div");
      row.className = "x-netease-song";
      row.style.gridTemplateColumns = "1fr auto";
      row.innerHTML = `
        <div>
          <div class="x-netease-title" title="${node.content || ""}">${node.content || ""}</div>
          <div class="x-netease-artist">${node.charId || "global"} · ${node.room || "living_room"}</div>
        </div>
        <div class="x-netease-artist">${typeof item.score === "number" ? item.score.toFixed(3) : ""}</div>
      `;
      box.appendChild(row);
    });
  }

  function bindVectorPanelEvents(panel) {
    panel.querySelector(".x-netease-close").addEventListener("click", () => {
      panel.style.display = "none";
    });
    panel.addEventListener("click", (event) => {
      if (event.target === panel) panel.style.display = "none";
    });

    document.getElementById("x-vector-save-cfg").addEventListener("click", () => {
      saveVectorCfgFromPanel();
      setVectorStatus("Embedding 配置已保存");
    });

    document.getElementById("x-vector-add").addEventListener("click", async () => {
      const cfg = saveVectorCfgFromPanel();
      const charId = document.getElementById("x-vector-char-id").value.trim() || "global";
      const content = document.getElementById("x-vector-content").value.trim();
      if (!content) return setVectorStatus("请输入要写入的内容", true);
      setVectorStatus("正在写入并向量化...");
      try {
        const node = await XVectorStore.addMemory({ charId, content }, cfg);
        setVectorStatus(`已写入：${node.id}`);
      } catch (error) {
        setVectorStatus(error.message || "写入失败", true);
      }
    });

    document.getElementById("x-vector-search").addEventListener("click", async () => {
      const cfg = saveVectorCfgFromPanel();
      const charId = document.getElementById("x-vector-char-id").value.trim() || "global";
      const query = document.getElementById("x-vector-query").value.trim();
      if (!query) return setVectorStatus("请输入搜索句子", true);
      setVectorStatus("正在语义搜索...");
      try {
        const results = await XVectorStore.search({
          charId,
          query,
          embeddingConfig: cfg,
          limit: 8,
        });
        renderVectorResults(results);
        setVectorStatus(`找到 ${results.length} 条结果`);
      } catch (error) {
        setVectorStatus(error.message || "搜索失败", true);
      }
    });

    document.getElementById("x-vector-list").addEventListener("click", async () => {
      const charId = document.getElementById("x-vector-char-id").value.trim() || "global";
      try {
        const rows = await XVectorStore.listMemories(charId);
        renderVectorResults(rows);
        setVectorStatus(`本分区共有 ${rows.length} 条记忆`);
      } catch (error) {
        setVectorStatus(error.message || "读取失败", true);
      }
    });
  }

  function openVectorPanel() {
    const panel = ensureVectorPanel();
    const cfg = loadVectorCfg();
    document.getElementById("x-vector-base-url").value = cfg.baseUrl || "";
    document.getElementById("x-vector-api-key").value = cfg.apiKey || "";
    document.getElementById("x-vector-model").value = cfg.model || DEFAULT_VECTOR_CFG.model;
    document.getElementById("x-vector-dimensions").value =
      cfg.dimensions || DEFAULT_VECTOR_CFG.dimensions;
    panel.style.display = "flex";
    setVectorStatus("本地 IndexedDB 向量库已就绪");
  }

  function installDesktopIcon() {
    const container = document.getElementById("desktop-app-container");
    if (!container) return;
    if (!document.getElementById("x-netease-app-icon")) {
      const icon = document.createElement("div");
      icon.id = "x-netease-app-icon";
      icon.className = "desktop-app-icon";
      icon.innerHTML = `
      <div class="icon-bg-desktop" style="background: linear-gradient(135deg,#d33b4d,#8f2231); color:#fff; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700;">云</div>
      <div class="label">网易云</div>
    `;
      icon.addEventListener("click", openMusicPanel);
      container.appendChild(icon);
    }
    if (!document.getElementById("x-vector-app-icon")) {
      const icon = document.createElement("div");
      icon.id = "x-vector-app-icon";
      icon.className = "desktop-app-icon";
      icon.innerHTML = `
      <div class="icon-bg-desktop" style="background: linear-gradient(135deg,#4a6072,#5f7665); color:#fff; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700;">向</div>
      <div class="label">向量库</div>
    `;
      icon.addEventListener("click", openVectorPanel);
      container.appendChild(icon);
    }
  }

  function boot() {
    window.XMusic = XMusic;
    window.XVectorStore = XVectorStore;
    window.XMemoryPalace = XMemoryPalace;
    installDesktopIcon();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
