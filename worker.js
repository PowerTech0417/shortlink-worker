export default {
  async fetch(request, env, ctx) {
    // === ✅ CORS 处理 ===
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    // === 🧹 定期清理已过期短链接 ===
    if (request.method === "DELETE") {
      try {
        const list = await env.LINKS.list();
        const now = Date.now();
        let removed = 0;

        for (const item of list.keys) {
          const value = await env.LINKS.get(item.name);
          if (!value) continue; // 🛡️ 避免 JSON 解析错误
          const data = JSON.parse(value);
          if (data.exp && data.exp < now) {
            await env.LINKS.delete(item.name);
            removed++;
          }
        }

        return new Response(JSON.stringify({ cleaned: removed }), {
          headers: corsHeaders(),
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: corsHeaders(),
        });
      }
    }

    // === ⛔ 仅支持 POST ===
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders(),
      });
    }

    // === 📦 主体逻辑 ===
    try {
      const { longURL, redirect } = await request.json();
      if (!longURL) throw new Error("Missing longURL");

      // === 🧩 Short.io 配置 ===
      const SHORTIO_DOMAIN = "pwbtw.com"; // ✅ 域名
      const SHORTIO_SECRET_KEY =
        env.SHORTIO_SECRET_KEY || "sk_xaA50GA8UhRaAtsh"; // ✅ API Key (建议改为环境变量)

      // === 🧠 解析 UID & 到期日期 ===
      const uidMatch = longURL.match(/uid=([^&]+)/);
      const expMatch = longURL.match(/exp=(\d+)/);
      const uid = uidMatch ? decodeURIComponent(uidMatch[1]) : null;
      const now = Date.now();

      let expTime = expMatch ? Number(expMatch[1]) : null;
      let durationText = "";
      let expDateText = "";

      if (expTime) {
        const diffDays = (expTime - now) / (1000 * 60 * 60 * 24);
        if (diffDays > 35000) durationText = "永久";
        else if (diffDays > 300) durationText = "1年";
        else if (diffDays > 25) durationText = "1月";
        else durationText = "短期";

        const expDate = new Date(expTime + 8 * 60 * 60 * 1000);
        expDateText = expDate.toISOString().slice(0, 10);
      }

      // 🇲🇾 马来西亚时间
      const malaysiaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const dateMY = malaysiaNow.toISOString().slice(0, 10);

      // === 📛 标题格式 ===
      let title = "";
      if (expDateText) {
        if (uid)
          title = `${uid} · 到期:${expDateText} · OTT ${durationText}链接 (${dateMY})`;
        else
          title = `到期:${expDateText} · OTT ${durationText}链接 (${dateMY})`;
      } else {
        if (uid) title = `${uid} · OTT 链接 (${dateMY})`;
        else title = `OTT 链接 (${dateMY})`;
      }

      // === 🔁 创建短链接（自动重试避免冲突）===
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

        const data = await res.json().catch(() => ({})); // 🛡️ 防止 JSON 解析出错

        if (res.ok && data.shortURL) {
          shortData = data;
          break;
        }

        if (data?.error?.includes("already exists")) continue;
        else if (data?.error) throw new Error(data.error);
      }

      if (!shortData) throw new Error("无法生成短链接，请稍后重试。");

      // === 💾 保存到 KV ===
      const record = {
        uid,
        longURL,
        shortURL: shortData.shortURL,
        exp: expTime || null,
        created: now,
        title,
      };
      await env.LINKS.put(id, JSON.stringify(record));

      // === 📺 redirect 模式 ===
      if (redirect === true || redirect === "1") {
        return Response.redirect(shortData.shortURL, 302);
      }

      // === 📦 返回结果 ===
      return new Response(JSON.stringify({ shortURL: shortData.shortURL }), {
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
};

// === 🌐 CORS 设置 ===
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };
}
