// server.js
// Минимальный сервер для Render: авторизация Strava, загрузка активностей,
// деавторизация, статус подключения, корректные куки для кросс-домена.

import express from "express";
import cors from "cors";
import axios from "axios";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/* ---------------- БАЗА ---------------- */
app.set("trust proxy", 1); // Render / прокси / HTTPS

const FRONTEND_URL = process.env.FRONTEND_URL || "https://globalsport.kz";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me_secret";

// CORS для фронта (кнопки/запросы с globalsport.kz)
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

/* ---------------- STRAVA CONFIG ---------------- */
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_REDIRECT_URI =
  process.env.STRAVA_REDIRECT_URI ||
  "https://globalsport-api.onrender.com/oauth/callback";

/* ---------------- УТИЛИТЫ ДЛЯ КУКИ ---------------- */
const setStravaCookie = (res, payload) => {
  res.cookie("strava", JSON.stringify(payload), {
    httpOnly: true,
    signed: true,
    sameSite: "None", // важно для кросс-домена
    secure: true,     // обязателен при SameSite=None
    maxAge: 30 * 24 * 3600 * 1000,
  });
};

const clearStravaCookie = (res) => {
  res.clearCookie("strava", {
    httpOnly: true,
    signed: true,
    sameSite: "None",
    secure: true,
  });
};

/* ---------------- СЛУЖЕБНОЕ ---------------- */
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) =>
  res.send("✅ API Globalsport запущен. Используйте /auth/strava для авторизации.")
);

/* ---------------- 1) СТАРТ АВТОРИЗАЦИИ ---------------- */
app.get("/auth/strava", (req, res) => {
  if (!STRAVA_CLIENT_ID || !STRAVA_REDIRECT_URI) {
    return res
      .status(500)
      .send("STRAVA_CLIENT_ID/STRAVA_REDIRECT_URI не заданы в окружении");
  }

  // Откуда возвращаться (например, https://globalsport.kz/challenge)
  const next =
    typeof req.query.next === "string" && req.query.next.startsWith("http")
      ? req.query.next
      : `${FRONTEND_URL}/challenge`;

  const scope = "read,activity:read_all";
  const url =
    "https://www.strava.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(STRAVA_CLIENT_ID)}` +
    "&response_type=code" +
    `&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}` +
    "&approval_prompt=auto" +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(next)}`; // сюда вернемся после авторизации

  return res.redirect(url);
});

/* ---------------- 2) CALLBACK: код -> токен ---------------- */
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const next =
    typeof req.query.state === "string" && req.query.state.startsWith("http")
      ? decodeURIComponent(req.query.state)
      : `${FRONTEND_URL}/challenge`;

  if (!code) return res.redirect(`${next}?error=missing_code`);

  try {
    const { data } = await axios.post("https://www.strava.com/oauth/token", {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    });

    const token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at, // unix seconds
      athlete_id: data.athlete?.id,
    };

    setStravaCookie(res, token);

    // Возвращаем на фронт с флагом успеха
    return res.redirect(`${next}?connected=1`);
  } catch (e) {
    console.error("TOKEN EXCHANGE ERROR:", e.response?.data || e.message);
    return res.redirect(`${next}?error=strava_token`);
  }
});

/* ---------------- ХЕЛПЕР: получить живой access_token ---------------- */
async function getAccessToken(req, res) {
  const raw = req.signedCookies?.strava;
  if (!raw) throw new Error("not_authorized");

  let token = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);

  // валиден — используем
  if (token.expires_at && token.expires_at - 60 > now) {
    return token.access_token;
  }

  // обновляем
  const { data } = await axios.post("https://www.strava.com/oauth/token", {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  });

  token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete_id: token.athlete_id,
  };

  setStravaCookie(res, token);
  return token.access_token;
}

/* ---------------- 3) СТАТУС (для фронта) ---------------- */
app.get("/api/status", (req, res) => {
  const raw = req.signedCookies?.strava;
  if (!raw) return res.json({ connected: false });

  try {
    const token = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    const connected = !!token.access_token && token.expires_at - 60 > now;
    return res.json({ connected, athlete_id: token.athlete_id || null });
  } catch {
    return res.json({ connected: false });
  }
});

/* ---------------- 4) ЗАГРУЗКА АКТИВНОСТЕЙ ---------------- */
app.get("/api/activities", async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const perPage = Number(req.query.per_page || 30);

    const accessToken = await getAccessToken(req, res);

    const { data } = await axios.get(
      "https://www.strava.com/api/v3/athlete/activities",
      {
        params: { page, per_page: perPage },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    return res.json(data);
  } catch (e) {
    if (e.message === "not_authorized") {
      return res.status(401).json({ error: "not_authorized" });
    }
    console.error("ACTIVITIES ERROR:", e.response?.data || e.message);
    return res.status(500).json({ error: "activities_failed" });
  }
});

/* ---------------- 5) ОТВЯЗАТЬ STRAVA (деавторизация) ---------------- */
app.get("/disconnect", async (req, res) => {
  const next =
    typeof req.query.next === "string" && req.query.next.startsWith("http")
      ? req.query.next
      : `${FRONTEND_URL}/challenge`;

  try {
    const raw = req.signedCookies?.strava;
    if (raw) {
      const token = JSON.parse(raw);
      if (token?.access_token) {
        // деавторизация приложения на стороне Strava
        await axios.post("https://www.strava.com/oauth/deauthorize", null, {
          params: { access_token: token.access_token },
        });
      }
    }
  } catch (e) {
    console.warn("Strava deauthorize warn:", e.response?.data || e.message);
  }

  clearStravaCookie(res);
  return res.redirect(`${next}?disconnected=1`);
});

/* ---------------- 6) ПРОСТО ВЫХОД (локально очистить куку) ---------------- */
app.get("/logout", (req, res) => {
  clearStravaCookie(res);
  res.send("Вышли. Cookie очищена.");
});

/* ---------------- СТАРТ ---------------- */
const PORT = process.env.PORT || 10000; // Render сам пробрасывает PORT
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
