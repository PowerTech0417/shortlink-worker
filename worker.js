export default {
  async fetch(request, env, ctx) {
    const SHORTIO_DOMAIN = "pwbtw.com";
    const SHORTIO_SECRET_KEY = "sk_xaA50GA8UhRaAtsh";
    // ===================================

    // 处理 OPTIONS 和非 POST 请求
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

      const now = Date.now();
      const uidMatch = longURL.match(/uid=([^&]+)/);
      const expMatch = longURL.match(/exp=(\d+)/);
      const uid = uidMatch ? decodeURIComponent(uidMatch[1]) : null;

      let expDateText = "";
      let expTime = null;
      let durationText = "短期";
      let isPermanent = false;

      // 解析到期时间逻辑不变
      if (expMatch) {
        expTime = Number(expMatch[1]);
        const diffDays = (expTime - now) / (1000 * 60 * 60 * 24);

        if (diffDays > 35000) {
          durationText = "永久";
          expDateText = "永久";
          isPermanent = true;
        } else {
          // 转换为马来西亚时间 (GMT+8)
          const expDate = new Date(expTime + 8 * 60 * 60 * 1000); 
          expDateText = expDate.toISOString().slice(0, 10);

          if (diffDays > 300) durationText = "1年";
          else if (diffDays > 25) durationText = "1月";
          else durationText = "短期";
        }
      }

      const malaysiaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const dateMY = malaysiaNow.toISOString().slice(0, 10);

      // 生成标题逻辑不变
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
      let shortioLinkId; 

      // 尝试调用 Short.io API 5 次逻辑不变
      for (let i = 0; i < 5; i++) {
        id = "id" + Math.floor(1000 + Math.random() * 90000);

        const res = await fetch("https://api.short.io/links", {
          method: "POST",
          headers: {
            Authorization: SHORTIO_SECRET_KEY, // 使用硬编码密钥
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            domain: SHORTIO_DOMAIN, // 使用硬编码域名
            originalURL: longURL,
            path: id,
            title,
          }),
        });

        const data = await res.json();
        if (res.ok && data.shortURL) {
          shortData = data;
          // 修复点 1：获取并保存 Short.io 的唯一 ID
          shortioLinkId = data.idString || data.id; 
          if (!shortioLinkId) throw new Error("Short.io API response missing link ID.");

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
        shortioLinkId: shortioLinkId, // 存储 Short.io 链接 ID
        longURL,
        exp: isPermanent ? null : expTime,
        created: now,
      };

      if (isPermanent) {
        await env.LINKS_KV.put(id, JSON.stringify(record));
      } else {
        await env.LINKS_KV.put(id, JSON.stringify(record), {
          expiration: Math.floor(expTime / 1000), // KV 过期时间单位是秒
        });
      }

      // 📺 redirect 模式（用于缓解 TV 访问问题，直接返回 302）
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

  // 改进的定时清理逻辑
  async scheduled(event, env, ctx) {
    // === 硬编码密钥 (按用户要求) ===
    const SHORTIO_SECRET_KEY = "sk_xaA50GA8UhRaAtsh";
    // ===================================
    
    const list = await env.LINKS_KV.list();
    const now = Date.now();
    
    // 如果密钥未设置（尽管已硬编码，但这是一个好的安全检查）
    if (!SHORTIO_SECRET_KEY || SHORTIO_SECRET_KEY === "sk_xaA50GA8UhRaAtsh") {
        console.error("❌ 清理失败：Short.io Secret Key is invalid or unset.");
        return;
    }

    for (const item of list.keys) {
      const data = await env.LINKS_KV.get(item.name, { type: "json" });
      if (!data) continue;
      
      // 检查是否过期，忽略永久链接 (data.exp === null)
      if (data.exp && now > data.exp) {
        
        // 改进点 2：调用 Short.io API 删除链接
        if (data.shortioLinkId) {
            console.log(`⏳ 正在删除 Short.io 链接: ${data.shortURL}`);
            
            const deleteRes = await fetch(`https://api.short.io/links/${data.shortioLinkId}`, {
                method: "DELETE",
                headers: {
                    Authorization: SHORTIO_SECRET_KEY, // 使用硬编码密钥
                    "Content-Type": "application/json",
                },
            });

            if (deleteRes.ok || deleteRes.status === 404) {
                // 成功删除或链接不存在（已被手动删除），视为成功
                console.log(`✅ 已从 Short.io 移除: ${data.shortURL}`);
            } else {
                const errorText = await deleteRes.text();
                console.error(`❌ Short.io 删除失败 (${data.shortURL}): Status ${deleteRes.status} - ${errorText}`);
                // 即使删除 Short.io 失败，仍继续删除 KV 记录，避免下次重复尝试
            }
        }
        
        // 改进点 3：删除 KV 存储记录
        await env.LINKS_KV.delete(item.name);
        console.log(`🗑️ 已删除过期 KV 记录: ${data.shortURL}`);
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
