// Supabase Edge Function: dog-watch 飞书机器人最小闭环
// 功能：接收飞书事件订阅推送 -> 校验 -> 回复"收到"
// Deno 运行时

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id, x-lark-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // 路由：/verify 用于飞书 URL 校验（配置回调时飞书会发 GET 校验）
  if (path === "/verify" && req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, challenge: url.searchParams.get("challenge") || "" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 只接受 POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.text();
    console.log("收到飞书推送:", body.slice(0, 1000));

    // 解析飞书事件结构
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      return new Response(JSON.stringify({ error: "invalid json" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const event = payload?.event || payload?.body?.event || null;
    if (!event) {
      // 可能是 URL 验证挑战
      if (payload?.challenge) {
        return new Response(JSON.stringify({ challenge: payload.challenge }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // im.message.receive_v1 事件结构
    const message = event?.message || {};
    const chatId = message?.chat_id || "";
    const messageId = message?.message_id || "";
    const msgType = message?.message_type || "";
    const sender = event?.sender?.sender_id?.open_id || "";

    // 提取消息内容（text 或 post）
    let text = "";
    try {
      const content = JSON.parse(message?.content || "{}");
      if (content?.text) text = content.text;
      else if (content?.title) text = content.title;
    } catch (e) {
      // ignore
    }

    // 只处理 @了机器人的消息（文本里通常含 @ 或用户直接发）
    // 这里简单回复"收到"作为最小闭环验证
    const replyText = `收到，dog-watch 已上线 ✅\n聊天ID: ${chatId}\n消息ID: ${messageId}\n类型: ${msgType}\n你说了: ${text || "(非文本消息)"}`;

    // 通过飞书 API 回复（需要环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）
    const appId = Deno.env.get("FEISHU_APP_ID");
    const appSecret = Deno.env.get("FEISHU_APP_SECRET");
    if (!appId || !appSecret) {
      console.error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET 环境变量");
      return new Response(JSON.stringify({ ok: true, note: "env missing, reply skipped" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 获取 tenant_access_token
    const tokenResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenJson = await tokenResp.json();
    const tenantToken = tokenJson?.tenant_access_token;

    if (!tenantToken) {
      console.error("获取 token 失败:", JSON.stringify(tokenJson));
      return new Response(JSON.stringify({ ok: true, note: "token failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 发送消息到原聊天
    const sendResp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${tenantToken}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: replyText }),
      }),
    });
    const sendJson = await sendResp.json();
    console.log("回复结果:", JSON.stringify(sendJson));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("处理异常:", err);
    return new Response(JSON.stringify({ ok: true, error: String(err) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
