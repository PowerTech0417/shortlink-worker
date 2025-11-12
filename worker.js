export default {
  async fetch(request, env, ctx) {
    // ✅ CORS 处理
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders(),
      });
    }

    try {
      // 📦 读取请求体
      const { longURL, redirect } = await request.json();
      if (!longURL) throw new Error("Missing longURL");

      // === 🧩 Short.io 配置 ===
      const SHORTIO_DOMAIN = "pwbtw.com"; // ✅ 域名
      const SHORTIO_SECRET_KEY = env.SHORTIO_SECRET_KEY || "sk_xaA50GA8UhRaAtsh"; // ✅ API Key

      // === 🧠 智能标题生成 ===
      let title = "link";
      const now = Date.now();
      const expMatch = longURL.match(/exp=(\d+)/);
      const uidMatch = longURL.match(/uid=([^&]+)/);
      const uid = uidMatch ? decodeURIComponent(uidMatch[1]) : null;

      let expDateText = "";
      let expTime = null;
      if (expMatch) {
        expTime = Number(expMatch[1]);
        const diffDays = (expTime - now) / (1000 * 60 * 60 * 24);
        const expDate = new Date(expTime + 8 * 60 * 60 * 1000); // 🇲🇾 UTC+8
        expDateText = expDate.toISOString().slice(0, 10);

        if (diffDays > 35000) title = "OTT 永久链接";
        else if (diffDays > 300) title = "OTT 1年链接";
        else if (diffDays > 25) title = "OTT 1个月链接";
        else title = "OTT 短期链接";

        // 🗓️ 加入到期日
        title += ` · 到期:${expDateText}`;
      }

      // 🇲🇾 当前日期
      const malaysiaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const dateMY = malaysiaNow.toISOString().slice(0, 10);
      if (uid) title += ` (${uid} · ${dateMY})`;
      else title += ` (${dateMY})`;

      // === 🔁 生成唯一 ID（自动防冲突）===
      let id, shortData;
      for (let i = 0; i < 5; i++) {
        id = "id" + Math.floor(1000 + Math.random() * 90000);

        const res = await fetch("https://api.short.io/links", {
          method: "POST",
          headers: {
            Authorization: SHORTIO_SECRET_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            domain: SHORTIO_DOMAIN,
            originalURL: longURL,
            path: id,
            title,
          }),
        });

        const data = await res.json();

        if (res.ok && data.shortURL) {
          shortData = data;
          break;
        }

        if (data.error && data.error.includes("already exists")) continue;
        else throw new Error(data.error || "Short.io API Error");
      }

      if (!shortData) throw new Error("无法生成短链接，请稍后重试。");

      // === 💾 存储到 KV（含过期时间） ===
      if (expTime) {
        const record = {
          id,
          shortURL: shortData.shortURL,
          longURL,
          exp: expTime,
          created: now,
        };
        await env.LINKS_KV.put(id, JSON.stringify(record), { expiration: Math.floor(expTime / 1000) });
      }

      // === 📺 redirect 模式（TV设备自动跳转）===
      if (redirect === true || redirect === "1") {
        return Response.redirect(shortData.shortURL, 302);
      }

      // === 默认返回 JSON（适合网页端）===
      return new Response(JSON.stringify({ shortURL: shortData.shortURL, expDate: expDateText }), {
        status: 200,
        headers: corsHeaders(),
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders(),
      });
    }
  },

  // === ⏰ 定时触发器，用于清理过期链接 ===
  async scheduled(event, env, ctx) {
    const list = await env.LINKS_KV.list();
    const now = Date.now();

    for (const item of list.keys) {
      const data = await env.LINKS_KV.get(item.name, { type: "json" });
      if (!data) continue;
      if (data.exp && now > data.exp) {
        await env.LINKS_KV.delete(item.name);
        console.log(`🗑️ 已删除过期链接: ${data.shortURL}`);
      }
    }
  },
};

// === 🌐 CORS 支持 ===
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };
          }
