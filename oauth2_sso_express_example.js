const express = require("express");
const session = require("express-session");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");

const app = express();
const PORT = 3000;

// OAuth2 / SSO 配置
const SSO_CONFIG = {
  authorizeUrl: "https://sso.saif.sjtu.edu.cn/sso/oauth2/authorize",
  tokenUrl: "https://sso.saif.sjtu.edu.cn/sso/oauth2/token",
  userinfoUrl: "https://sso.saif.sjtu.edu.cn/sso/apis/v2/me/profile",
  clientId: "CBy6qdemiDPqAotJm5HB",
  clientSecret: "6E109273F434FE070DE3E07C8FD99B04894A75CBBFDA45B0",
  redirectUri: "http://localhost:3000/callback",
  scope: "openid profile",
  loginNameField: "account"
};

app.use(
  session({
    secret: "replace-with-a-long-random-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax"
    }
  })
);

function buildAuthorizeUrl(state) {
  const url = new URL(SSO_CONFIG.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", SSO_CONFIG.clientId);
  url.searchParams.set("redirect_uri", SSO_CONFIG.redirectUri);
  url.searchParams.set("scope", SSO_CONFIG.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

function decodeJwtWithoutVerify(token) {
  const payload = jwt.decode(token);
  if (!payload) {
    throw new Error("access_token 不是合法 JWT，无法解析用户信息");
  }
  return payload;
}

function htmlPage(title, body) {
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f7fb; margin:0; padding:40px; color:#222; }
        .card { max-width: 760px; margin: 0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:16px; padding:28px; box-shadow:0 12px 30px rgba(15,23,42,.06); }
        h1 { margin-top:0; }
        pre { background:#0f172a; color:#e2e8f0; padding:16px; border-radius:12px; overflow:auto; }
        .button { display:inline-block; background:#1d4ed8; color:#fff; text-decoration:none; padding:10px 16px; border-radius:10px; font-weight:600; }
        .muted { color:#6b7280; }
      </style>
    </head>
    <body>
      <div class="card">${body}</div>
    </body>
  </html>`;
}

// 1. 用户访问系统首页 /
app.get("/", (req, res) => {
  // 2. 如果未登录，重定向到 /login
  if (!req.session.user) {
    return res.redirect("/login");
  }

  res.send(
    htmlPage(
      "首页",
      `
      <h1>SSO 登录成功</h1>
      <p>当前用户信息如下：</p>
      <p class="muted">建议重点确认 userInfo.${SSO_CONFIG.loginNameField} 是否为你后续系统映射本地账号所需字段。</p>
      <pre>${JSON.stringify(req.session.user, null, 2)}</pre>
      <p><a class="button" href="/logout">退出登录</a></p>
      `
    )
  );
});

// 3. /login 重定向到 SSO 的授权地址
app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(buildAuthorizeUrl(state));
});

// 4. 用户在 SSO 登录成功后，回调 /callback?code=xxx
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send(htmlPage("错误", "<h1>缺少授权码 code</h1>"));
  }

  if (!state || state !== req.session.oauthState) {
    return res.status(400).send(htmlPage("错误", "<h1>state 校验失败，疑似非法请求</h1>"));
  }

  try {
    // 5. 服务端用 code 调用 token_url 换取 access_token
    const tokenResp = await axios.post(
      SSO_CONFIG.tokenUrl,
      new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: SSO_CONFIG.redirectUri,
        client_id: SSO_CONFIG.clientId,
        client_secret: SSO_CONFIG.clientSecret
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 10000
      }
    );

    const accessToken = tokenResp.data.access_token;
    if (!accessToken) {
      return res.status(500).send(
        htmlPage(
          "错误",
          `<h1>token 接口未返回 access_token</h1><pre>${JSON.stringify(tokenResp.data, null, 2)}</pre>`
        )
      );
    }

    // 6. 使用 jwt 解析 access_token 获取用户信息
    let userFromJwt = null;
    try {
      userFromJwt = decodeJwtWithoutVerify(accessToken);
    } catch (_error) {
      userFromJwt = null;
    }

    // 可选兜底：如果 SSO 还提供 userinfo 接口，则再取一次更完整信息
    let userFromUserInfo = null;
    try {
      const userInfoResp = await axios.get(SSO_CONFIG.userinfoUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 10000
      });
      userFromUserInfo = userInfoResp.data;
    } catch (_error) {
      userFromUserInfo = null;
    }

    const finalUser = {
      accessToken,
      jwtPayload: userFromJwt,
      userInfo: userFromUserInfo || userFromJwt,
      loginName: (userFromUserInfo && userFromUserInfo[SSO_CONFIG.loginNameField]) || (userFromJwt && userFromJwt[SSO_CONFIG.loginNameField]) || null
    };

    // 7. 将用户信息存入 session
    req.session.user = finalUser;
    delete req.session.oauthState;

    // 8. 登录完成后跳转回 /
    return res.redirect("/");
  } catch (error) {
    const detail = error.response
      ? {
          status: error.response.status,
          data: error.response.data
        }
      : {
          message: error.message
        };

    return res.status(500).send(
      htmlPage(
        "SSO 错误",
        `
        <h1>SSO 登录失败</h1>
        <p class="muted">请检查 SAIF SSO 的 authorize/token/profile 配置、client_id、client_secret、redirect_uri 是否正确。</p>
        <pre>${JSON.stringify(detail, null, 2)}</pre>
        <p><a class="button" href="/login">重新登录</a></p>
        `
      )
    );
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.listen(PORT, () => {
  console.log(`SSO 示例服务已启动: http://localhost:${PORT}`);
  console.log(`authorizeUrl = ${SSO_CONFIG.authorizeUrl}`);
  console.log(`tokenUrl     = ${SSO_CONFIG.tokenUrl}`);
  console.log(`userinfoUrl  = ${SSO_CONFIG.userinfoUrl}`);
  console.log(`redirectUri  = ${SSO_CONFIG.redirectUri}`);
  console.log(`loginField   = ${SSO_CONFIG.loginNameField}`);
});
