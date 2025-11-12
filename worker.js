export default {
  async fetch(request, env, ctx) {
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
      const { longURL, redirect } = await request.json();
      if (!longURL) throw new Error("Missing longURL");

      const SHORTIO_DOMAIN = "pwbtw.com";
      const SHORTIO_SECRET_KEY = env.SHORTIO_SECRET_KEY || "sk_xaA50GA8UhRaAtsh";

      const now = Date.now();
      const uidMatch = longURL.match(/uid=([^&]+)/);
      const expMatch = longURL.match(/exp=(\d+)/);
      const uid = uidMatch ? decodeURIComponent(uidMatch[1]) : null;

      let expDateText = "";
      let expTime = null;
      let durationText = "短期";
      let isPermanent = false;

      if (expMatch) {
        expTime = Number(expMatch[1]);
        const diffDays = (expTime - now) / (1000 * 60 * 60 * 24);

        if (diffDays > 35000) {
          durationText = "永久";
          expDateText = "永久";
          isPermanent = true;
        } else {
          const expDate = new Date(expTime + 8 * 60 * 60 * 1000);
          expDateText = expDate.toISOString().slice(0, 10);

          if (diffDays > 300) durationText = "1年";
          else if (diffDays > 25) durationText = "1月";
          else durationText = "短期";
        }
      }

      const malaysiaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const dateMY = malaysiaNow.toISOString().slice(0, 10);

      let title = "";
      if (uid && expDateText)
        title = `(${uid} - ${expDateText} - ${durationText})`;
      else if (uid)
        title = `(${uid} - ${durationText})`;
      else if (expDateText)
        title = `(到期:${expDateText} - ${durationText})`;
      else
        title = `(OTT 链接 - ${dateMY})`;

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

      // 💾 KV存储（永久链接不设过期）
      const record = {
        id,
        shortURL: shortData.shortURL,
        longURL,
        exp: isPermanent ? null : expTime,
        created: now,
      };

      if (isPermanent) {
        await env.LINKS_KV.put(id, JSON.stringify(record));
      } else {
        await env.LINKS_KV.put(id, JSON.stringify(record), {
          expiration: Math.floor(expTime / 1000),
        });
      }

      // 📺 redirect 模式
      if (redirect === true || redirect === "1") {
        return Response.redirect(shortData.shortURL, 302);
      }

      // ✅ 浏览器可直接显示短链
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html") || accept.includes("text/plain")) {
        return new Response(shortData.shortURL, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // 默认返回 JSON
      return new Response(
        JSON.stringify({
          shortURL: shortData.shortURL,
          title,
          expDate: expDateText,
          duration: durationText,
        }),
        { status: 200, headers: corsHeaders() }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders(),
      });
    }
  },

  // 定时清理（忽略永久）
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
  };
}
