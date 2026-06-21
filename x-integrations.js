(function () {
  "use strict";

  const MUSIC_CFG_KEY = "x_netease_music_cfg_v1";
  const VECTOR_CFG_KEY = "x_vector_embedding_cfg_v1";
  const LIGHT_LLM_CFG_KEY = "x_memory_light_llm_cfg_v1";
  const RERANK_CFG_KEY = "x_memory_rerank_cfg_v1";
  const REMOTE_VECTOR_CFG_KEY = "x_memory_remote_vector_cfg_v1";
  const ROLE_PLAYLISTS_KEY = "x_netease_role_playlists_v1";
  const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
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
  const DEFAULT_LIGHT_LLM_CFG = {
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.2,
  };
  const DEFAULT_RERANK_CFG = {
    enabled: false,
    baseUrl: "",
    apiKey: "",
    model: "BAAI/bge-reranker-v2-m3",
    topN: 8,
  };
  const DEFAULT_REMOTE_VECTOR_CFG = {
    enabled: false,
    supabaseUrl: "",
    anonKey: "",
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

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function shortText(value, max = 120) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function normalizeCookie(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (/MUSIC_U=/i.test(value)) return value;
    return value.toUpperCase().startsWith("MUSIC_U=")
      ? value
      : `MUSIC_U=${value}`;
  }

  function toHttps(url) {
    if (!url || typeof url !== "string") return url || "";
    return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
  }

  function firstApiKey(apiKey) {
    const value = String(apiKey || "");
    if (typeof window.getRandomValue === "function") return window.getRandomValue(value);
    return value.split(/[,，\n]/)[0].trim();
  }

  function modelListUrl(baseUrl) {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    if (!base) return "";
    if (/generativelanguage\.googleapis\.com|gemini/i.test(base)) {
      return GEMINI_MODELS_URL;
    }
    return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  }

  async function fetchModelList(baseUrl, apiKey) {
    const url = modelListUrl(baseUrl);
    if (!url || !apiKey) throw new Error("请先填写 Base URL 和 API Key");
    const isGemini = url === GEMINI_MODELS_URL;
    const res = await fetch(
      isGemini ? `${url}?key=${encodeURIComponent(firstApiKey(apiKey))}` : url,
      isGemini
        ? undefined
        : { headers: { Authorization: `Bearer ${firstApiKey(apiKey)}` } },
    );
    if (!res.ok) throw new Error(`模型列表 ${res.status}: ${(await res.text()).slice(0, 180)}`);
    const data = await res.json();
    const rows = isGemini ? data.models || [] : data.data || data.models || [];
    return rows
      .map((item) => {
        const raw = item.id || item.name || item.model || "";
        const id = isGemini && raw.includes("/") ? raw.split("/").pop() : raw;
        return String(id || "").trim();
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  function getArtists(song) {
    const list = song?.ar || song?.artists || [];
    if (Array.isArray(list) && list.length) {
      return list.map((item) => item.name).filter(Boolean).join(" / ");
    }
    return song?.artist || song?.artists || "未知歌手";
  }

  function getCurrentChatForIntegrations() {
    const chats = window.state?.chats || {};
    const activeId = window.state?.activeChatId || window.state?.currentChatId;
    return (activeId && chats[activeId]) || null;
  }

  function loadRolePlaylists() {
    return readJson(ROLE_PLAYLISTS_KEY, {});
  }

  function saveRolePlaylists(data) {
    writeJson(ROLE_PLAYLISTS_KEY, data || {});
  }

  function getRolePlaylist(chatId) {
    const all = loadRolePlaylists();
    return Array.isArray(all[chatId]) ? all[chatId] : [];
  }

  function setRolePlaylist(chatId, songs) {
    const all = loadRolePlaylists();
    all[chatId] = (songs || []).map((song) => ({
      id: Number(song.id),
      name: song.name || "未知歌曲",
      artist: song.artist || getArtists(song),
      album: song.album || getAlbum(song).name || "",
      cover: song.cover || toHttps(getAlbum(song).picUrl || ""),
      raw: song.raw || song,
    }));
    saveRolePlaylists(all);
    return all[chatId];
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
      const payload = { ...(body || {}) };
      if (cookie && !payload.cookie) payload.cookie = cookie;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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

    userDetail(uid, cfg) {
      return XMusic.call("/user/detail", { uid: Number(uid) }, cfg);
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

  function loadLightLLMCfg() {
    return readJson(LIGHT_LLM_CFG_KEY, DEFAULT_LIGHT_LLM_CFG);
  }

  function saveLightLLMCfg(cfg) {
    const next = {
      ...DEFAULT_LIGHT_LLM_CFG,
      ...cfg,
      baseUrl: String(cfg.baseUrl || "").trim(),
      apiKey: String(cfg.apiKey || "").trim(),
      model: String(cfg.model || "").trim(),
      temperature: Number(cfg.temperature ?? DEFAULT_LIGHT_LLM_CFG.temperature),
    };
    writeJson(LIGHT_LLM_CFG_KEY, next);
    return next;
  }

  function loadRerankCfg() {
    return readJson(RERANK_CFG_KEY, DEFAULT_RERANK_CFG);
  }

  function saveRerankCfg(cfg) {
    const next = {
      ...DEFAULT_RERANK_CFG,
      ...cfg,
      enabled: Boolean(cfg.enabled),
      baseUrl: String(cfg.baseUrl || "").trim(),
      apiKey: String(cfg.apiKey || "").trim(),
      model: String(cfg.model || DEFAULT_RERANK_CFG.model).trim(),
      topN: Math.max(1, Number(cfg.topN || DEFAULT_RERANK_CFG.topN)),
    };
    writeJson(RERANK_CFG_KEY, next);
    return next;
  }

  function loadRemoteVectorCfg() {
    return readJson(REMOTE_VECTOR_CFG_KEY, DEFAULT_REMOTE_VECTOR_CFG);
  }

  function saveRemoteVectorCfg(cfg) {
    const next = {
      ...DEFAULT_REMOTE_VECTOR_CFG,
      ...cfg,
      enabled: Boolean(cfg.enabled),
      supabaseUrl: String(cfg.supabaseUrl || "").trim(),
      anonKey: String(cfg.anonKey || "").trim(),
    };
    writeJson(REMOTE_VECTOR_CFG_KEY, next);
    return next;
  }

  async function callChatModelForMemory(prompt) {
    const lightCfg = loadLightLLMCfg();
    const hasLightLLM = lightCfg.baseUrl && lightCfg.apiKey && lightCfg.model;
    const cfg = hasLightLLM
      ? {
          proxyUrl: lightCfg.baseUrl,
          apiKey: lightCfg.apiKey,
          model: lightCfg.model,
          temperature: lightCfg.temperature,
        }
      : window.state?.apiConfig || {};
    if (!cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      throw new Error("记忆提炼副 API 或主聊天 API 未配置");
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
        temperature: Number(cfg.temperature ?? 0.2),
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
      const minChunkSize = options.force ? Math.min(5, MEMORY_CHUNK_SIZE) : MEMORY_CHUNK_SIZE;

      while (messages.length - cursor >= minChunkSize) {
        const take = options.force
          ? Math.min(MEMORY_CHUNK_SIZE, messages.length - cursor)
          : MEMORY_CHUNK_SIZE;
        const chunk = messages.slice(cursor, cursor + take);
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
        cursor += chunk.length;
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

  const musicUiState = {
    tab: "profile",
    songs: [],
    profile: null,
    playlists: [],
    currentTrack: null,
  };
  const memoryUiState = {
    selectedChatId: null,
    selectedRoom: "living_room",
  };

  async function persistActiveChatSettings() {
    const chat = getCurrentChatForIntegrations();
    if (!chat) return null;
    if (!chat.settings) chat.settings = {};
    chat.settings.roleApi = {
      enabled: document.getElementById("x-role-api-enabled")?.checked || false,
      proxyUrl: document.getElementById("x-role-api-base-url")?.value.trim() || "",
      apiKey: document.getElementById("x-role-api-key")?.value.trim() || "",
      model: document.getElementById("x-role-api-model")?.value.trim() || "",
      temperature: Number(document.getElementById("x-role-api-temperature")?.value || 0.8),
    };
    try {
      if (typeof db !== "undefined" && db?.chats?.put) await db.chats.put(chat);
    } catch (error) {
      console.warn("[XIntegrations] role api settings saved in memory only", error);
    }
    return chat.settings.roleApi;
  }

  function fillRoleApiPanel() {
    const card = document.getElementById("x-role-api-card");
    if (!card) return;
    const chat = getCurrentChatForIntegrations();
    const cfg = chat?.settings?.roleApi || {};
    card.style.display = chat ? "block" : "none";
    document.getElementById("x-role-api-title").textContent = chat
      ? `角色独立 API · ${chat.name || "当前聊天"}`
      : "角色独立 API";
    document.getElementById("x-role-api-enabled").checked = Boolean(cfg.enabled);
    document.getElementById("x-role-api-base-url").value = cfg.proxyUrl || "";
    document.getElementById("x-role-api-key").value = cfg.apiKey || "";
    document.getElementById("x-role-api-model").value = cfg.model || "";
    document.getElementById("x-role-api-temperature").value = cfg.temperature ?? 0.8;
  }

  function installRoleApiSettingsPanel() {
    if (document.getElementById("x-role-api-card")) {
      fillRoleApiPanel();
      return;
    }
    const modalBody = document.querySelector("#chat-settings-modal .moe-settings-body");
    if (!modalBody) return;
    const card = document.createElement("div");
    card.id = "x-role-api-card";
    card.className = "settings-group-card moe-card";
    card.innerHTML = `
      <div class="settings-section-title" id="x-role-api-title">角色独立 API</div>
      <div class="form-group">
        <label class="toggle-switch-label">
          <span class="toggle-switch-text">启用当前角色独立 API</span>
          <input type="checkbox" id="x-role-api-enabled" />
          <span class="toggle-switch-slider"></span>
        </label>
      </div>
      <div class="form-group">
        <label>Base URL / 反代地址</label>
        <input id="x-role-api-base-url" class="moe-input" type="url" placeholder="https://api.openai.com 或 Gemini models 地址" />
      </div>
      <div class="form-group">
        <label>API Key</label>
        <input id="x-role-api-key" class="moe-input" type="password" />
      </div>
      <div class="form-group">
        <label>模型</label>
        <input id="x-role-api-model" class="moe-input" type="text" placeholder="选择或手动输入模型" />
        <select id="x-role-api-model-list" class="moe-input" style="display:none;margin-top:6px;"></select>
      </div>
      <div class="form-group">
        <label>Temperature</label>
        <input id="x-role-api-temperature" class="moe-input" type="number" min="0" max="2" step="0.1" />
      </div>
      <button id="x-role-api-fetch-models" class="moe-btn-secondary" type="button">📡 拉取角色模型列表</button>
      <button id="x-role-api-save" class="moe-btn-secondary" type="button" style="margin-top:8px;">保存角色 API</button>
      <p id="x-role-api-status" style="font-size:12px;color:#888;margin:8px 0 0;"></p>
    `;
    modalBody.insertBefore(card, modalBody.children[1] || null);
    card.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const status = document.getElementById("x-role-api-status");
      if (target.id === "x-role-api-save") {
        await persistActiveChatSettings();
        if (status) status.textContent = "已保存当前角色独立 API。";
      }
      if (target.id === "x-role-api-fetch-models") {
        if (status) status.textContent = "正在拉取模型列表...";
        try {
          const models = await fetchModelList(
            document.getElementById("x-role-api-base-url").value,
            document.getElementById("x-role-api-key").value,
          );
          fillModelSelect("x-role-api-model-list", "x-role-api-model", models);
          if (status) status.textContent = `已拉取 ${models.length} 个模型。`;
        } catch (error) {
          if (status) status.textContent = error.message || "拉取失败";
        }
      }
    });
    document.getElementById("save-chat-settings-btn")?.addEventListener(
      "click",
      () => {
        persistActiveChatSettings();
      },
      true,
    );
    document.getElementById("chat-settings-btn")?.addEventListener("click", () => {
      setTimeout(() => {
        installRoleApiSettingsPanel();
        fillRoleApiPanel();
      }, 120);
    });
    fillRoleApiPanel();
  }

  function fillModelSelect(selectId, inputId, models) {
    const select = document.getElementById(selectId);
    const input = document.getElementById(inputId);
    if (!select || !input) return;
    select.innerHTML = `<option value="">▼ 选择已拉取的模型</option>`;
    models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });
    select.style.display = "block";
    select.onchange = () => {
      if (select.value) input.value = select.value;
    };
  }

  function ensureIntegrationStyles() {
    if (document.getElementById("x-integrations-styles")) return;
    const style = document.createElement("style");
    style.id = "x-integrations-styles";
    style.textContent = `
      #x-netease-panel,
      #x-vector-panel {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: none;
        overflow: hidden;
        background: rgba(226, 237, 246, 0.72);
        backdrop-filter: blur(18px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #274052;
      }
      #x-netease-panel.visible,
      #x-vector-panel.visible { display: block; }
      .x-app-shell {
        height: 100%;
        display: grid;
        grid-template-rows: auto 1fr;
        background:
          linear-gradient(135deg, rgba(247,251,255,.96), rgba(230,244,255,.92) 46%, rgba(255,247,250,.94)),
          #f7fbff;
      }
      .x-app-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 18px clamp(18px, 3vw, 34px);
        border-bottom: 1px solid rgba(91, 145, 181, 0.18);
      }
      .x-app-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .x-app-mark {
        width: 42px;
        height: 42px;
        border-radius: 14px;
        display: grid;
        place-items: center;
        color: #fff;
        font-weight: 800;
        box-shadow: 0 12px 32px rgba(74, 132, 177, 0.24);
      }
      .x-app-title h2 { margin: 0; font-size: clamp(20px, 2.8vw, 32px); line-height: 1; letter-spacing: 0; }
      .x-app-title p { margin: 5px 0 0; font-size: 13px; color: #6f8ca1; }
      .x-close-btn,
      .x-chip-btn,
      .x-primary-btn,
      .x-ghost-btn {
        border: 0;
        cursor: pointer;
        font: inherit;
        letter-spacing: 0;
      }
      .x-close-btn {
        width: 38px;
        height: 38px;
        border-radius: 12px;
        background: rgba(80, 124, 153, 0.12);
        color: #496b81;
        font-size: 24px;
      }
      .x-chip-btn,
      .x-primary-btn,
      .x-ghost-btn {
        min-height: 36px;
        border-radius: 999px;
        padding: 8px 13px;
        white-space: nowrap;
      }
      .x-primary-btn { background: #5aa9e6; color: #fff; box-shadow: 0 10px 22px rgba(90,169,230,.26); }
      .x-ghost-btn { background: rgba(90,169,230,.12); color: #2e668f; }
      .x-chip-btn { background: rgba(255,255,255,.72); color: #43677d; border: 1px solid rgba(90,169,230,.22); }
      .x-chip-btn.active { background: #ffb7c5; color: #7d3446; border-color: transparent; }
      .x-field { display: grid; gap: 6px; }
      .x-field label { color: #668399; font-size: 12px; font-weight: 700; }
      .x-input,
      .x-select,
      .x-textarea {
        width: 100%;
        box-sizing: border-box;
        min-height: 38px;
        border: 1px solid rgba(89, 149, 189, .24);
        border-radius: 12px;
        background: rgba(255,255,255,.86);
        color: #274052;
        padding: 8px 11px;
        font-size: 13px;
        outline: none;
      }
      .x-textarea { min-height: 88px; resize: vertical; }
      .x-status { min-height: 22px; color: #668399; font-size: 13px; }
      .x-status.error { color: #ca4f66; }
      .x-music-main {
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 330px;
        gap: 18px;
        padding: clamp(16px, 3vw, 30px);
      }
      .x-music-stage,
      .x-music-side,
      .x-palace-side,
      .x-palace-main,
      .x-palace-settings {
        min-height: 0;
        overflow: auto;
        border: 1px solid rgba(90,169,230,.18);
        background: rgba(255,255,255,.58);
        box-shadow: 0 22px 56px rgba(82, 128, 158, .14);
      }
      .x-music-stage,
      .x-music-side,
      .x-palace-side,
      .x-palace-main,
      .x-palace-settings { border-radius: 8px; }
      .x-music-stage { padding: clamp(16px, 2.6vw, 26px); }
      .x-music-side { padding: 16px; display: grid; align-content: start; gap: 14px; }
      .x-music-hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 18px;
        align-items: end;
        margin-bottom: 18px;
      }
      .x-music-hero h3 { margin: 0; font-size: clamp(28px, 5vw, 64px); letter-spacing: 0; color: #315b76; }
      .x-music-hero p { margin: 8px 0 0; color: #7392a8; }
      .x-search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
      .x-tab-row,
      .x-action-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .x-song-list,
      .x-playlist-list,
      .x-memory-list,
      .x-chat-list { display: grid; gap: 10px; }
      .x-song-row {
        display: grid;
        grid-template-columns: 58px minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 10px;
        border-radius: 8px;
        background: rgba(255,255,255,.76);
        border: 1px solid rgba(90,169,230,.16);
      }
      .x-song-row img,
      .x-profile-avatar {
        width: 58px;
        height: 58px;
        object-fit: cover;
        border-radius: 8px;
        background: #dcebf6;
      }
      .x-song-title,
      .x-card-title {
        color: #29495d;
        font-weight: 800;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .x-song-sub,
      .x-card-sub { color: #7392a8; font-size: 12px; margin-top: 3px; }
      .x-profile-card,
      .x-mini-player,
      .x-config-card,
      .x-memory-card,
      .x-room-card,
      .x-chat-card {
        border-radius: 8px;
        background: rgba(255,255,255,.68);
        border: 1px solid rgba(90,169,230,.16);
      }
      .x-profile-card,
      .x-config-card,
      .x-memory-card,
      .x-chat-card { padding: 13px; }
      .x-profile-card { display: grid; grid-template-columns: 58px 1fr; gap: 12px; align-items: center; }
      .x-mini-player {
        display: grid;
        grid-template-columns: 44px 1fr auto;
        gap: 10px;
        align-items: center;
        padding: 10px;
      }
      .x-mini-player img { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; background: #dcebf6; }
      .x-config-card { display: grid; gap: 10px; }
      .x-qr-box {
        display: none;
        place-items: center;
        min-height: 210px;
        border-radius: 8px;
        background: rgba(255,255,255,.72);
      }
      .x-qr-box img { width: 190px; max-width: 100%; border-radius: 8px; }
      .x-palace-layout {
        min-height: 0;
        display: grid;
        grid-template-columns: 260px minmax(0, 1fr) 340px;
        gap: 18px;
        padding: clamp(16px, 3vw, 30px);
      }
      .x-palace-side,
      .x-palace-main,
      .x-palace-settings { padding: 16px; }
      .x-palace-kicker { color: #6f8ca1; font-size: 12px; font-weight: 800; text-transform: uppercase; }
      .x-palace-heading { margin: 5px 0 12px; color: #29495d; font-size: 22px; letter-spacing: 0; }
      .x-chat-card {
        width: 100%;
        text-align: left;
        color: inherit;
        cursor: pointer;
      }
      .x-chat-card.active { border-color: rgba(255,183,197,.8); background: rgba(255,247,250,.82); }
      .x-room-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 12px;
      }
      .x-room-card {
        padding: 14px;
        text-align: left;
        cursor: pointer;
        color: inherit;
      }
      .x-room-card.active { border-color: rgba(90,169,230,.62); background: rgba(236,247,255,.9); }
      .x-room-count { margin-top: 10px; font-size: 24px; color: #315b76; font-weight: 900; }
      .x-memory-card { display: grid; gap: 7px; }
      .x-memory-content { color: #34576b; line-height: 1.48; white-space: pre-wrap; overflow-wrap: anywhere; }
      .x-tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .x-tag { border-radius: 999px; padding: 4px 8px; background: rgba(90,169,230,.12); color: #45708a; font-size: 11px; }
      .x-progress {
        height: 8px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(90,169,230,.14);
        margin-top: 8px;
      }
      .x-progress > span { display: block; height: 100%; background: linear-gradient(90deg,#5aa9e6,#ffb7c5); }
      .x-toggle-line { display: flex; gap: 8px; align-items: center; color: #668399; font-size: 13px; }
      @media (max-width: 980px) {
        .x-music-main,
        .x-palace-layout { grid-template-columns: 1fr; overflow: auto; }
        .x-music-side,
        .x-palace-side,
        .x-palace-settings { overflow: visible; }
        .x-app-shell { overflow: auto; }
      }
      @media (max-width: 640px) {
        .x-app-topbar { padding: 14px; }
        .x-music-main,
        .x-palace-layout { padding: 12px; gap: 12px; }
        .x-music-hero,
        .x-search-row,
        .x-song-row { grid-template-columns: 1fr; }
        .x-song-row img { width: 100%; height: 160px; }
      }
    `;
    document.head.appendChild(style);
  }

  function loadVectorCfg() {
    return readJson(VECTOR_CFG_KEY, DEFAULT_VECTOR_CFG);
  }

  function saveVectorCfg(cfg) {
    const next = {
      ...DEFAULT_VECTOR_CFG,
      ...cfg,
      baseUrl: String(cfg.baseUrl || "").trim(),
      apiKey: String(cfg.apiKey || "").trim(),
      model: String(cfg.model || DEFAULT_VECTOR_CFG.model).trim(),
      dimensions: Number(cfg.dimensions || DEFAULT_VECTOR_CFG.dimensions),
    };
    writeJson(VECTOR_CFG_KEY, next);
    return next;
  }

  function ensurePanel() {
    let panel = document.getElementById("x-netease-panel");
    if (panel) return panel;
    ensureIntegrationStyles();

    panel = document.createElement("div");
    panel.id = "x-netease-panel";
    panel.innerHTML = `
      <div class="x-app-shell">
        <header class="x-app-topbar">
          <div class="x-app-title">
            <div class="x-app-mark" style="background:linear-gradient(135deg,#5aa9e6,#ffb7c5);">音</div>
            <div>
              <h2>未来音楽</h2>
              <p>网易云音乐 · 一起听播放器联动</p>
            </div>
          </div>
          <button class="x-close-btn" type="button" data-close="music" title="关闭">×</button>
        </header>
        <main class="x-music-main">
          <section class="x-music-stage">
            <div class="x-music-hero">
              <div>
                <h3>Music</h3>
                <p>搜索、日推、私人 FM 和桌面播放器在这里汇合。</p>
              </div>
              <div class="x-tab-row">
                <button class="x-chip-btn active" type="button" data-music-tab="profile">我的</button>
                <button class="x-chip-btn" type="button" data-music-tab="search">搜索</button>
                <button class="x-chip-btn" type="button" data-music-tab="library">歌单</button>
              </div>
            </div>
            <div class="x-search-row">
              <input id="x-music-keyword" class="x-input" type="search" placeholder="搜索歌名 / 歌手" />
              <button id="x-music-search" class="x-primary-btn" type="button">搜索</button>
            </div>
            <div class="x-action-row" style="margin:12px 0 16px;">
              <button id="x-music-daily" class="x-ghost-btn" type="button">日推</button>
              <button id="x-music-fm" class="x-ghost-btn" type="button">私人 FM</button>
              <button id="x-music-open-player" class="x-ghost-btn" type="button">打开播放器</button>
            </div>
            <div id="x-music-status" class="x-status"></div>
            <div id="x-music-main-content"></div>
          </section>
          <aside class="x-music-side">
            <div id="x-music-profile-box"></div>
            <div class="x-config-card">
              <div class="x-card-title">网易云连接</div>
              <div class="x-field">
                <label>Worker 地址</label>
                <input id="x-music-worker-url" class="x-input" type="url" />
              </div>
              <div class="x-field">
                <label>Cookie / MUSIC_U</label>
                <input id="x-music-cookie" class="x-input" type="password" placeholder="MUSIC_U" />
              </div>
              <div class="x-field">
                <label>音质</label>
                <select id="x-music-quality" class="x-select">
                  <option value="standard">standard</option>
                  <option value="higher">higher</option>
                  <option value="exhigh">exhigh</option>
                  <option value="lossless">lossless</option>
                  <option value="hires">hires</option>
                  <option value="jyeffect">jyeffect</option>
                  <option value="sky">sky</option>
                  <option value="jymaster">jymaster</option>
                </select>
              </div>
              <div class="x-action-row">
                <button id="x-music-save" class="x-primary-btn" type="button">保存</button>
                <button id="x-music-test" class="x-ghost-btn" type="button">测试登录</button>
                <button id="x-music-qr" class="x-ghost-btn" type="button">扫码登录</button>
              </div>
              <div id="x-music-qr-box" class="x-qr-box"></div>
            </div>
            <div id="x-music-mini" class="x-mini-player"></div>
          </aside>
        </main>
      </div>
    `;
    document.body.appendChild(panel);
    bindPanelEvents(panel);
    return panel;
  }

  function getPanelCfg() {
    return XMusic.saveCfg({
      workerUrl: document.getElementById("x-music-worker-url")?.value,
      cookie: document.getElementById("x-music-cookie")?.value,
      quality: document.getElementById("x-music-quality")?.value,
    });
  }

  function setStatus(message, isError = false) {
    const el = document.getElementById("x-music-status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", Boolean(isError));
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

  function renderMusicTabs() {
    document.querySelectorAll("[data-music-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.musicTab === musicUiState.tab);
    });
  }

  function renderMusicProfileBox() {
    const box = document.getElementById("x-music-profile-box");
    if (!box) return;
    const profile = musicUiState.profile;
    if (!profile) {
      box.innerHTML = `
        <div class="x-profile-card" style="grid-template-columns:1fr;">
          <div>
            <div class="x-card-title">网易云账号</div>
            <div class="x-card-sub">未读取登录状态</div>
          </div>
        </div>
      `;
      return;
    }
    box.innerHTML = `
      <div class="x-profile-card">
        <img class="x-profile-avatar" src="${escapeHtml(toHttps(profile.avatarUrl || ""))}" alt="" />
        <div>
          <div class="x-card-title">${escapeHtml(profile.nickname || "网易云用户")}</div>
          <div class="x-card-sub">UID ${escapeHtml(profile.userId || profile.userIdStr || "")}</div>
        </div>
      </div>
    `;
  }

  function renderMusicMini() {
    const box = document.getElementById("x-music-mini");
    if (!box) return;
    const track =
      musicUiState.currentTrack ||
      window.state?.musicState?.playlist?.[window.state?.musicState?.currentIndex || 0] ||
      null;
    if (!track) {
      box.innerHTML = `
        <div style="width:44px;height:44px;border-radius:8px;background:#dcebf6;"></div>
        <div>
          <div class="x-card-title">桌面播放器</div>
          <div class="x-card-sub">等待加入歌曲</div>
        </div>
        <button class="x-ghost-btn" type="button" id="x-mini-open-player">打开</button>
      `;
      return;
    }
    box.innerHTML = `
      <img src="${escapeHtml(track.cover || "")}" alt="" />
      <div>
        <div class="x-card-title">${escapeHtml(track.name || "未知歌曲")}</div>
        <div class="x-card-sub">${escapeHtml(track.artist || "")}</div>
      </div>
      <button class="x-ghost-btn" type="button" id="x-mini-open-player">打开</button>
    `;
  }

  function extractNeteaseProfile(data) {
    return (
      data?.data?.profile ||
      data?.profile ||
      data?.data?.account?.profile ||
      data?.account?.profile ||
      null
    );
  }

  function extractNeteaseUid(data) {
    const profile = extractNeteaseProfile(data);
    return (
      profile?.userId ||
      data?.data?.account?.id ||
      data?.account?.id ||
      data?.data?.userId ||
      data?.userId ||
      null
    );
  }

  function extractNeteasePlaylists(data) {
    return (
      data?.playlist ||
      data?.data?.playlist ||
      data?.result?.playlist ||
      data?.playlists ||
      []
    );
  }

  function renderSongs(songs) {
    musicUiState.songs = songs.map(compactSong);
    musicUiState.tab = "search";
    renderMusicTabs();
    const box = document.getElementById("x-music-main-content");
    if (!box) return;
    if (!musicUiState.songs.length) {
      box.innerHTML = `<div class="x-status">没有找到歌曲。</div>`;
      return;
    }
    box.innerHTML = `
      <div class="x-song-list">
        ${musicUiState.songs
          .map(
            (song, index) => `
              <div class="x-song-row">
                <img src="${escapeHtml(song.cover || "https://i.postimg.cc/pT2xKzPz/album-cover-placeholder.png")}" alt="" />
                <div>
                  <div class="x-song-title" title="${escapeHtml(song.name)}">${escapeHtml(song.name)}</div>
                  <div class="x-song-sub">${escapeHtml(song.artist)}${song.album ? ` · ${escapeHtml(song.album)}` : ""}</div>
                </div>
                <div class="x-action-row">
                  <button class="x-ghost-btn" type="button" data-song-add="${index}">加入</button>
                  <button class="x-primary-btn" type="button" data-song-play="${index}">播放</button>
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderMusicHome() {
    renderMusicTabs();
    renderMusicProfileBox();
    renderMusicMini();
    const box = document.getElementById("x-music-main-content");
    if (!box) return;
    const roleChat = getCurrentChatForIntegrations();
    const rolePlaylist = roleChat ? getRolePlaylist(roleChat.id) : [];
    if (musicUiState.tab === "library") {
      box.innerHTML = `
        <div class="x-action-row" style="margin-bottom:12px;">
          <button class="x-primary-btn" type="button" id="x-music-save-role-playlist">保存当前列表为角色歌单</button>
          <button class="x-ghost-btn" type="button" id="x-music-load-role-playlist">加载角色歌单</button>
          <button class="x-ghost-btn" type="button" id="x-music-clear-role-playlist">清空角色歌单</button>
        </div>
        <div class="x-profile-card" style="grid-template-columns:1fr;margin-bottom:12px;">
          <div class="x-card-title">${escapeHtml(roleChat?.name || "当前角色")}的本地歌单</div>
          <div class="x-card-sub">${rolePlaylist.length} 首 · 保存搜索/日推/网易云歌单结果后可一键加入播放器</div>
        </div>
        <div class="x-playlist-list">
          ${
            musicUiState.playlists.length
              ? musicUiState.playlists
                  .map(
                    (item) => `
                      <button class="x-chat-card" type="button" data-playlist-id="${escapeHtml(item.id)}">
                        <div class="x-card-title">${escapeHtml(item.name || "未命名歌单")}</div>
                        <div class="x-card-sub">${Number(item.trackCount || 0)} 首 · ${escapeHtml(item.creator?.nickname || "")}</div>
                      </button>
                    `,
                  )
                  .join("")
              : `<div class="x-status">登录后可读取网易云歌单。</div>`
          }
        </div>
      `;
      return;
    }
    if (musicUiState.tab === "search" && musicUiState.songs.length) {
      renderSongs(musicUiState.songs);
      return;
    }
    box.innerHTML = `
      <div class="x-profile-card" style="grid-template-columns:1fr;">
        <div class="x-card-title">网易云音乐</div>
        <div class="x-card-sub">扫码或粘贴 MUSIC_U 后，可以拉日推、私人 FM、歌单，并把歌曲送进 miniphone 的桌面播放器。</div>
      </div>
    `;
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
      musicUiState.currentTrack = track;
      renderMusicMini();
      setStatus(playNow ? `正在播放《${song.name}》` : `已加入《${song.name}》到一起听歌单`);
    } catch (error) {
      console.error("[XMusic] add song failed", error);
      setStatus(error.message || "添加失败", true);
    }
  }

  async function refreshMusicProfile() {
    setStatus("正在读取网易云账号...");
    const data = await XMusic.loginStatus(getPanelCfg());
    let profile = extractNeteaseProfile(data);
    const uid = extractNeteaseUid(data);
    if (!profile && uid) {
      const detail = await XMusic.userDetail(uid, getPanelCfg()).catch(() => null);
      profile = detail?.profile || detail?.data?.profile || { userId: uid, nickname: `UID ${uid}` };
    }
    musicUiState.profile = profile || null;
    musicUiState.playlists = [];
    const playlistUid = profile?.userId || uid;
    if (playlistUid) {
      const playlists = await XMusic.userPlaylist(playlistUid, getPanelCfg()).catch((error) => {
        console.warn("[XMusic] playlist failed", error);
        return null;
      });
      musicUiState.playlists = extractNeteasePlaylists(playlists);
    }
    musicUiState.tab = "library";
    renderMusicHome();
    setStatus(
      profile
        ? `已登录：${profile.nickname || playlistUid}，歌单 ${musicUiState.playlists.length} 个`
        : "未登录或 Cookie 无效",
      !profile,
    );
  }

  function bindPanelEvents(panel) {
    panel.querySelector('[data-close="music"]').addEventListener("click", () => {
      panel.classList.remove("visible");
    });
    panel.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.musicTab) {
        musicUiState.tab = target.dataset.musicTab;
        renderMusicHome();
      }
      if (target.id === "x-mini-open-player" || target.id === "x-music-open-player") {
        if (window.ephoneMusicBridge?.openPlayer) {
          window.ephoneMusicBridge.openPlayer();
          document.getElementById("x-netease-panel")?.classList.remove("visible");
          setStatus("已打开桌面播放器。");
        } else {
          setStatus("播放器尚未初始化，请稍后再试", true);
        }
      }
      if (target.id === "x-music-save") {
        getPanelCfg();
        setStatus("配置已保存");
      }
      if (target.id === "x-music-test") {
        try {
          await refreshMusicProfile();
        } catch (error) {
          setStatus(error.message || "测试失败", true);
        }
      }
      if (target.id === "x-music-qr") startQrLogin();
      if (target.id === "x-music-search") runMusicSearch();
      if (target.id === "x-music-daily") runMusicDaily();
      if (target.id === "x-music-fm") runMusicFm();
      if (target.id === "x-music-save-role-playlist") saveCurrentRolePlaylist();
      if (target.id === "x-music-load-role-playlist") loadCurrentRolePlaylist();
      if (target.id === "x-music-clear-role-playlist") clearCurrentRolePlaylist();
      if (target.dataset.songAdd) addSong(musicUiState.songs[Number(target.dataset.songAdd)], false);
      if (target.dataset.songPlay) addSong(musicUiState.songs[Number(target.dataset.songPlay)], true);
      if (target.dataset.playlistId) loadPlaylistSongs(target.dataset.playlistId);
    });
    panel.querySelector("#x-music-keyword").addEventListener("keydown", (event) => {
      if (event.key === "Enter") runMusicSearch();
    });
  }

  async function runMusicSearch() {
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
  }

  async function runMusicDaily() {
    setStatus("正在拉取日推...");
    try {
      const data = await XMusic.recommendSongs(getPanelCfg());
      const songs = extractSongsFromResult(data);
      renderSongs(songs);
      setStatus(`日推 ${songs.length} 首`);
    } catch (error) {
      setStatus(error.message || "日推失败，请确认已登录网易云", true);
    }
  }

  async function runMusicFm() {
    setStatus("正在拉取私人 FM...");
    try {
      const data = await XMusic.personalFm(getPanelCfg());
      const songs = extractSongsFromResult(data);
      renderSongs(songs);
      setStatus(`私人 FM ${songs.length} 首`);
    } catch (error) {
      setStatus(error.message || "私人 FM 失败，请确认已登录网易云", true);
    }
  }

  async function loadPlaylistSongs(playlistId) {
    setStatus("正在读取歌单...");
    try {
      const data = await XMusic.playlistTrackAll(playlistId, getPanelCfg(), 80, 0);
      const songs = data?.songs || data?.data?.songs || data?.playlist?.tracks || [];
      renderSongs(songs);
      setStatus(`歌单 ${songs.length} 首`);
    } catch (error) {
      setStatus(error.message || "读取歌单失败", true);
    }
  }

  function saveCurrentRolePlaylist() {
    const chat = getCurrentChatForIntegrations();
    if (!chat) return setStatus("请先进入一个角色聊天，再保存角色歌单", true);
    if (!musicUiState.songs.length) return setStatus("当前没有歌曲列表可保存", true);
    const saved = setRolePlaylist(chat.id, musicUiState.songs);
    musicUiState.tab = "library";
    renderMusicHome();
    setStatus(`已保存 ${saved.length} 首到「${chat.name}」的角色歌单`);
  }

  function loadCurrentRolePlaylist() {
    const chat = getCurrentChatForIntegrations();
    if (!chat) return setStatus("请先进入一个角色聊天，再加载角色歌单", true);
    const songs = getRolePlaylist(chat.id);
    if (!songs.length) return setStatus(`「${chat.name}」还没有角色歌单`, true);
    renderSongs(songs);
    setStatus(`已载入「${chat.name}」的 ${songs.length} 首角色歌单`);
  }

  function clearCurrentRolePlaylist() {
    const chat = getCurrentChatForIntegrations();
    if (!chat) return setStatus("请先进入一个角色聊天", true);
    setRolePlaylist(chat.id, []);
    musicUiState.tab = "library";
    renderMusicHome();
    setStatus(`已清空「${chat.name}」的角色歌单`);
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
        ? `<img src="${escapeHtml(qrimg)}" alt="网易云登录二维码" />`
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
            await refreshMusicProfile().catch(() => null);
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
    renderMusicHome();
    setStatus("可搜索歌曲后加入现有“一起听”歌单");
    if (cfg.cookie) {
      refreshMusicProfile().catch((error) => {
        setStatus(error.message || "登录状态读取失败，请重新扫码", true);
      });
    }
  }

  function getMemoryChats() {
    const source = window.state?.chats || window.chats || [];
    const list = Array.isArray(source) ? source : Object.values(source);
    return list
      .filter((chat) => chat?.id && Array.isArray(chat.history))
      .map((chat) => ({
        ...chat,
        displayName: chat.name || chat.title || chat.character?.name || chat.id,
      }));
  }

  function getSelectedMemoryChat() {
    const chats = getMemoryChats();
    if (!chats.length) return null;
    const selected =
      chats.find((chat) => chat.id === memoryUiState.selectedChatId) ||
      chats.find((chat) => chat.id === window.state?.currentChatId) ||
      chats[0];
    memoryUiState.selectedChatId = selected.id;
    return selected;
  }

  function roomName(roomKey) {
    const label = MEMORY_ROOMS[roomKey] || roomKey || "客厅";
    return String(label).split(" - ")[0];
  }

  function roomHint(roomKey) {
    const label = MEMORY_ROOMS[roomKey] || "";
    return String(label).split(" - ")[1] || "";
  }

  function ensureVectorPanel() {
    let panel = document.getElementById("x-vector-panel");
    if (panel) return panel;
    ensureIntegrationStyles();

    panel = document.createElement("div");
    panel.id = "x-vector-panel";
    panel.innerHTML = `
      <div class="x-app-shell">
        <header class="x-app-topbar">
          <div class="x-app-title">
            <div class="x-app-mark" style="background:linear-gradient(135deg,#425f74,#6fb69a);">向</div>
            <div>
              <h2>Memory Palace</h2>
              <p>记忆宫殿 · IndexedDB 向量库 · 副 API 提炼</p>
            </div>
          </div>
          <button class="x-close-btn" type="button" data-close="vector" title="关闭">×</button>
        </header>
        <main class="x-palace-layout">
          <aside class="x-palace-side">
            <div class="x-palace-kicker">Characters</div>
            <h3 class="x-palace-heading">聊天分区</h3>
            <div id="x-memory-chat-list" class="x-chat-list"></div>
          </aside>
          <section class="x-palace-main">
            <div class="x-palace-kicker">Rooms</div>
            <h3 id="x-memory-heading" class="x-palace-heading">记忆房间</h3>
            <div class="x-action-row" style="margin-bottom:12px;">
              <button id="x-memory-process-full" class="x-primary-btn" type="button">处理满 70 条</button>
              <button id="x-memory-process-force" class="x-ghost-btn" type="button">追平到最新</button>
              <button id="x-memory-toggle-chat" class="x-ghost-btn" type="button">暂停自动记忆</button>
              <button id="x-memory-clear-chat" class="x-ghost-btn" type="button">清空本聊天</button>
            </div>
            <div id="x-vector-status" class="x-status"></div>
            <div id="x-room-grid" class="x-room-grid"></div>
            <div style="height:16px;"></div>
            <div class="x-palace-kicker">Memories</div>
            <h3 id="x-room-heading" class="x-palace-heading">房间记忆</h3>
            <div id="x-vector-results" class="x-memory-list"></div>
          </section>
          <aside class="x-palace-settings">
            <div class="x-palace-kicker">Settings</div>
            <h3 class="x-palace-heading">向量库调用</h3>
            <div class="x-config-card">
              <div class="x-card-title">Embedding API</div>
              <div class="x-field"><label>Base URL</label><input id="x-vector-base-url" class="x-input" type="url" placeholder="https://api.siliconflow.cn/v1" /></div>
              <div class="x-field"><label>API Key</label><input id="x-vector-api-key" class="x-input" type="password" /></div>
              <div class="x-field"><label>模型</label><input id="x-vector-model" class="x-input" type="text" /></div>
              <select id="x-vector-model-list" class="x-select" style="display:none;"></select>
              <div class="x-field"><label>维度</label><input id="x-vector-dimensions" class="x-input" type="number" min="1" step="1" /></div>
              <button id="x-vector-fetch-models" class="x-ghost-btn" type="button">拉取 Embedding 模型</button>
            </div>
            <div style="height:12px;"></div>
            <div class="x-config-card">
              <div class="x-card-title">副 API / Light LLM</div>
              <div class="x-field"><label>Base URL</label><input id="x-light-base-url" class="x-input" type="url" placeholder="https://api.openai.com" /></div>
              <div class="x-field"><label>API Key</label><input id="x-light-api-key" class="x-input" type="password" /></div>
              <div class="x-field"><label>模型</label><input id="x-light-model" class="x-input" type="text" placeholder="gpt-4o-mini" /></div>
              <select id="x-light-model-list" class="x-select" style="display:none;"></select>
              <div class="x-field"><label>Temperature</label><input id="x-light-temperature" class="x-input" type="number" min="0" max="2" step="0.1" /></div>
              <button id="x-light-fetch-models" class="x-ghost-btn" type="button">拉取副 API 模型</button>
            </div>
            <div style="height:12px;"></div>
            <div class="x-config-card">
              <div class="x-card-title">Rerank</div>
              <label class="x-toggle-line"><input id="x-rerank-enabled" type="checkbox" /> 启用</label>
              <div class="x-field"><label>Base URL</label><input id="x-rerank-base-url" class="x-input" type="url" /></div>
              <div class="x-field"><label>API Key</label><input id="x-rerank-api-key" class="x-input" type="password" /></div>
              <div class="x-field"><label>模型</label><input id="x-rerank-model" class="x-input" type="text" /></div>
              <div class="x-field"><label>Top N</label><input id="x-rerank-top-n" class="x-input" type="number" min="1" step="1" /></div>
            </div>
            <div style="height:12px;"></div>
            <div class="x-config-card">
              <div class="x-card-title">远程向量 / Supabase</div>
              <label class="x-toggle-line"><input id="x-remote-vector-enabled" type="checkbox" /> 启用</label>
              <div class="x-field"><label>Supabase URL</label><input id="x-remote-supabase-url" class="x-input" type="url" /></div>
              <div class="x-field"><label>Anon Key</label><input id="x-remote-anon-key" class="x-input" type="password" /></div>
            </div>
            <div style="height:12px;"></div>
            <div class="x-config-card">
              <div class="x-card-title">手动写入 / 搜索</div>
              <div class="x-field"><label>房间</label><select id="x-vector-room" class="x-select">${Object.entries(MEMORY_ROOMS).map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("")}</select></div>
              <div class="x-field"><label>写入内容</label><textarea id="x-vector-content" class="x-textarea"></textarea></div>
              <div class="x-action-row">
                <button id="x-vector-save-cfg" class="x-primary-btn" type="button">保存配置</button>
                <button id="x-vector-add" class="x-ghost-btn" type="button">写入</button>
              </div>
              <div class="x-field"><label>语义搜索</label><input id="x-vector-query" class="x-input" type="search" /></div>
              <button id="x-vector-search" class="x-ghost-btn" type="button">搜索</button>
            </div>
          </aside>
        </main>
      </div>
    `;
    document.body.appendChild(panel);
    bindVectorPanelEvents(panel);
    return panel;
  }

  function fillMemoryConfigInputs() {
    const vector = loadVectorCfg();
    const light = loadLightLLMCfg();
    const rerank = loadRerankCfg();
    const remote = loadRemoteVectorCfg();
    document.getElementById("x-vector-base-url").value = vector.baseUrl || "";
    document.getElementById("x-vector-api-key").value = vector.apiKey || "";
    document.getElementById("x-vector-model").value = vector.model || DEFAULT_VECTOR_CFG.model;
    document.getElementById("x-vector-dimensions").value = vector.dimensions || DEFAULT_VECTOR_CFG.dimensions;
    document.getElementById("x-light-base-url").value = light.baseUrl || "";
    document.getElementById("x-light-api-key").value = light.apiKey || "";
    document.getElementById("x-light-model").value = light.model || "";
    document.getElementById("x-light-temperature").value = light.temperature ?? DEFAULT_LIGHT_LLM_CFG.temperature;
    document.getElementById("x-rerank-enabled").checked = Boolean(rerank.enabled);
    document.getElementById("x-rerank-base-url").value = rerank.baseUrl || "";
    document.getElementById("x-rerank-api-key").value = rerank.apiKey || "";
    document.getElementById("x-rerank-model").value = rerank.model || DEFAULT_RERANK_CFG.model;
    document.getElementById("x-rerank-top-n").value = rerank.topN || DEFAULT_RERANK_CFG.topN;
    document.getElementById("x-remote-vector-enabled").checked = Boolean(remote.enabled);
    document.getElementById("x-remote-supabase-url").value = remote.supabaseUrl || "";
    document.getElementById("x-remote-anon-key").value = remote.anonKey || "";
  }

  function saveMemoryConfigsFromPanel() {
    const vector = saveVectorCfg({
      baseUrl: document.getElementById("x-vector-base-url").value,
      apiKey: document.getElementById("x-vector-api-key").value,
      model: document.getElementById("x-vector-model").value,
      dimensions: Number(document.getElementById("x-vector-dimensions").value || 0),
    });
    saveLightLLMCfg({
      baseUrl: document.getElementById("x-light-base-url").value,
      apiKey: document.getElementById("x-light-api-key").value,
      model: document.getElementById("x-light-model").value,
      temperature: Number(document.getElementById("x-light-temperature").value || 0.2),
    });
    saveRerankCfg({
      enabled: document.getElementById("x-rerank-enabled").checked,
      baseUrl: document.getElementById("x-rerank-base-url").value,
      apiKey: document.getElementById("x-rerank-api-key").value,
      model: document.getElementById("x-rerank-model").value,
      topN: Number(document.getElementById("x-rerank-top-n").value || DEFAULT_RERANK_CFG.topN),
    });
    saveRemoteVectorCfg({
      enabled: document.getElementById("x-remote-vector-enabled").checked,
      supabaseUrl: document.getElementById("x-remote-supabase-url").value,
      anonKey: document.getElementById("x-remote-anon-key").value,
    });
    return vector;
  }

  function setVectorStatus(message, isError = false) {
    const el = document.getElementById("x-vector-status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", Boolean(isError));
  }

  async function renderMemoryPalace() {
    const chat = getSelectedMemoryChat();
    const chats = getMemoryChats();
    const chatList = document.getElementById("x-memory-chat-list");
    const heading = document.getElementById("x-memory-heading");
    if (!chat || !chatList) {
      if (chatList) chatList.innerHTML = `<div class="x-status">暂无聊天记录。</div>`;
      return;
    }
    chatList.innerHTML = chats
      .map((item) => {
        const total = visibleChatMessages(item).length;
        const progress = XMemoryPalace.getProgress(item.id);
        const pct = total ? Math.min(100, Math.round((progress / total) * 100)) : 0;
        return `
          <button class="x-chat-card ${item.id === chat.id ? "active" : ""}" type="button" data-memory-chat="${escapeHtml(item.id)}">
            <div class="x-card-title">${escapeHtml(item.displayName)}</div>
            <div class="x-card-sub">${progress}/${total} · ${isMemoryEnabled(item.id) ? "自动记忆" : "已暂停"}</div>
            <div class="x-progress"><span style="width:${pct}%"></span></div>
          </button>
        `;
      })
      .join("");

    const memories = await XVectorStore.listMemories(chat.id);
    const byRoom = new Map(Object.keys(MEMORY_ROOMS).map((key) => [key, []]));
    memories.forEach((node) => {
      const room = MEMORY_ROOMS[node.room] ? node.room : "living_room";
      byRoom.get(room).push(node);
    });
    for (const rows of byRoom.values()) {
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    if (!byRoom.has(memoryUiState.selectedRoom)) memoryUiState.selectedRoom = "living_room";
    const selectedRows = byRoom.get(memoryUiState.selectedRoom) || [];
    const total = visibleChatMessages(chat).length;
    const progress = XMemoryPalace.getProgress(chat.id);
    const buffer = Math.max(0, total - progress);
    heading.textContent = `${chat.displayName} · ${progress}/${total} · 缓冲 ${buffer}`;
    const toggleBtn = document.getElementById("x-memory-toggle-chat");
    if (toggleBtn) {
      toggleBtn.textContent = isMemoryEnabled(chat.id) ? "暂停自动记忆" : "启用自动记忆";
    }

    document.getElementById("x-room-grid").innerHTML = Object.entries(MEMORY_ROOMS)
      .map(([key]) => {
        const rows = byRoom.get(key) || [];
        return `
          <button class="x-room-card ${key === memoryUiState.selectedRoom ? "active" : ""}" type="button" data-memory-room="${key}">
            <div class="x-card-title">${escapeHtml(roomName(key))}</div>
            <div class="x-card-sub">${escapeHtml(roomHint(key))}</div>
            <div class="x-room-count">${rows.length}</div>
          </button>
        `;
      })
      .join("");
    document.getElementById("x-room-heading").textContent = `${roomName(memoryUiState.selectedRoom)} · ${selectedRows.length}`;
    renderVectorResults(selectedRows);
  }

  function renderVectorResults(items) {
    const box = document.getElementById("x-vector-results");
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<div class="x-status">暂无结果。</div>`;
      return;
    }
    box.innerHTML = items
      .map((item) => {
        const node = item.node || item;
        const score = typeof item.score === "number" ? `<span class="x-tag">${item.score.toFixed(3)}</span>` : "";
        const tags = [
          roomName(node.room),
          ...(Array.isArray(node.tags) ? node.tags.slice(0, 4) : []),
        ];
        return `
          <article class="x-memory-card">
            <div class="x-tag-row">
              ${tags.map((tag) => `<span class="x-tag">${escapeHtml(tag)}</span>`).join("")}
              ${score}
            </div>
            <div class="x-memory-content">${escapeHtml(shortText(node.content || "", 420))}</div>
            <div class="x-card-sub">${escapeHtml(node.charId || "global")} · ${new Date(node.createdAt || Date.now()).toLocaleString()}</div>
          </article>
        `;
      })
      .join("");
  }

  function bindVectorPanelEvents(panel) {
    panel.querySelector('[data-close="vector"]').addEventListener("click", () => {
      panel.classList.remove("visible");
    });
    panel.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.memoryChat) {
        memoryUiState.selectedChatId = target.dataset.memoryChat;
        await renderMemoryPalace();
      }
      if (target.dataset.memoryRoom) {
        memoryUiState.selectedRoom = target.dataset.memoryRoom;
        await renderMemoryPalace();
      }
      if (target.id === "x-vector-save-cfg") {
        saveMemoryConfigsFromPanel();
        setVectorStatus("配置已保存");
      }
      if (target.id === "x-vector-fetch-models" || target.id === "x-light-fetch-models") {
        const isVector = target.id === "x-vector-fetch-models";
        setVectorStatus(isVector ? "正在拉取 Embedding 模型列表..." : "正在拉取副 API 模型列表...");
        try {
          const models = await fetchModelList(
            document.getElementById(isVector ? "x-vector-base-url" : "x-light-base-url").value,
            document.getElementById(isVector ? "x-vector-api-key" : "x-light-api-key").value,
          );
          fillModelSelect(
            isVector ? "x-vector-model-list" : "x-light-model-list",
            isVector ? "x-vector-model" : "x-light-model",
            models,
          );
          setVectorStatus(`已拉取 ${models.length} 个模型`);
        } catch (error) {
          setVectorStatus(error.message || "拉取模型失败", true);
        }
      }
      if (target.id === "x-vector-add") {
        const chat = getSelectedMemoryChat();
        const content = document.getElementById("x-vector-content").value.trim();
        const room = document.getElementById("x-vector-room").value || "living_room";
        if (!chat) return setVectorStatus("暂无聊天分区", true);
        if (!content) return setVectorStatus("请输入要写入的内容", true);
        setVectorStatus("正在写入并向量化...");
        try {
          const cfg = saveMemoryConfigsFromPanel();
          await XVectorStore.addMemory(
            { charId: chat.id, content, room, tags: ["manual"], importance: 6 },
            getEmbeddingCfgOrNull() ? cfg : undefined,
          );
          document.getElementById("x-vector-content").value = "";
          setVectorStatus("已写入");
          await renderMemoryPalace();
        } catch (error) {
          setVectorStatus(error.message || "写入失败", true);
        }
      }
      if (target.id === "x-vector-search") {
        const chat = getSelectedMemoryChat();
        const query = document.getElementById("x-vector-query").value.trim();
        if (!chat) return setVectorStatus("暂无聊天分区", true);
        if (!query) return setVectorStatus("请输入搜索句子", true);
        setVectorStatus("正在语义搜索...");
        try {
          const cfg = saveMemoryConfigsFromPanel();
          const results = await XVectorStore.search({
            charId: chat.id,
            query,
            embeddingConfig: cfg,
            limit: 12,
          });
          renderVectorResults(results);
          setVectorStatus(`找到 ${results.length} 条结果`);
        } catch (error) {
          setVectorStatus(error.message || "搜索失败", true);
        }
      }
      if (target.id === "x-memory-process-full" || target.id === "x-memory-process-force") {
        const chat = getSelectedMemoryChat();
        if (!chat) return setVectorStatus("暂无聊天分区", true);
        setVectorStatus("正在处理聊天记录...");
        try {
          saveMemoryConfigsFromPanel();
          const result = await XMemoryPalace.processChatIfNeeded(chat, {
            force: target.id === "x-memory-process-force",
          });
          setVectorStatus(`已处理 ${result.processed || 0} 条，进度 ${result.cursor || XMemoryPalace.getProgress(chat.id)}`);
          await renderMemoryPalace();
        } catch (error) {
          setVectorStatus(error.message || "处理失败", true);
        }
      }
      if (target.id === "x-memory-toggle-chat") {
        const chat = getSelectedMemoryChat();
        if (!chat) return setVectorStatus("暂无聊天分区", true);
        const next = !isMemoryEnabled(chat.id);
        XMemoryPalace.setEnabled(chat.id, next);
        setVectorStatus(next ? "已启用自动记忆" : "已暂停自动记忆");
        await renderMemoryPalace();
      }
      if (target.id === "x-memory-clear-chat") {
        const chat = getSelectedMemoryChat();
        if (!chat) return setVectorStatus("暂无聊天分区", true);
        if (!confirm(`清空「${chat.displayName}」的向量记忆？`)) return;
        try {
          await XVectorStore.wipe(chat.id);
          XMemoryPalace.setProgress(chat.id, 0);
          setVectorStatus("已清空本聊天记忆");
          await renderMemoryPalace();
        } catch (error) {
          setVectorStatus(error.message || "清空失败", true);
        }
      }
    });
  }

  function openVectorPanel() {
    const panel = ensureVectorPanel();
    fillMemoryConfigInputs();
    const current = getSelectedMemoryChat();
    if (current) memoryUiState.selectedChatId = current.id;
    panel.classList.add("visible");
    setVectorStatus("本地 IndexedDB 向量库已就绪");
    renderMemoryPalace().catch((error) => setVectorStatus(error.message || "读取失败", true));
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
    window.XFetchModelList = fetchModelList;
    installRoleApiSettingsPanel();
    installDesktopIcon();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
