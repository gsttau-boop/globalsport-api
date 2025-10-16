// server.js
// Полный минимальный сервер для Render с авторизацией Strava и загрузкой активностей

import express from "express";
import cors from "cors";
import axios from "axios";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/* ---------- Базовая настройка ---------- */
app.set("trust proxy", 1); // Render/прокси/HTTPS

const FRONTEND_URL = process.env.FRONTEND_URL || "https://globalsport.kz";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me_secret";

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

/* ---------- Конфиг Strava ---------- */
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_REDIRECT_URI =
  process.env.STRAVA_REDIRECT_URI ||
  "https://globalsport-api.onrender.com/oauth/callback";

/* ---------- Служебное ---------- */
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) =>
  res.send("✅ API Globalsport запущен. /auth/strava для авторизации.")
);

/* ---------- 1) Старт авторизации ---------- */
app.get("/auth/strava", (req, res) => {
  if (!STRAVA_CLIENT_ID || !STRAVA_REDIRECT_URI) {
    return res
      .status(500)
      .send("STRAVA_CLIENT_ID/STRAVA_REDIRECT_URI не заданы в окружении");
  }

  const scope = "read,activity:read_all";
  const url =
    "https://www.strava.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(STRAVA_CLIENT_ID)}` +
    "&response_type=code" +
    `&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}` +
    "&approval_prompt=auto" +
    `&scope=${encodeURIComponent(scope)}`;

  return res.redirect(url);
});

// ... всё как у вас выше

/* ---------- 2) Callback: меняем code на токен, сохраняем в cookie ---------- */
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("❌ Нет кода авторизации (code).");

  try {
    const { data } = await axios.post("https://www.strava.com/oauth/token", {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    });

    // то, что будем хранить
    const token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at, // unix seconds
      athlete_id: data.athlete?.id,
    };

    // ✅ фикс: token (а не payload) + кросс-сайт настройки куки
    res.cookie("strava", JSON.stringify(token), {
      httpOnly: true,
      signed: true,
      sameSite: "none",
      secure: true,
      maxAge: 30 * 24 * 3600 * 1000,
      path: "/",
    });

    return res.send("✅ Подключение выполнено. Можно загружать тренировки.");
  } catch (e) {
    console.error("TOKEN EXCHANGE ERROR:", e.response?.data || e.message);
    return res.status(500).send("❌ Ошибка обмена кода на токен");
  }
});

/* ---------- Хелпер: дать живой access_token, при необходимости обновить ---------- */
async function getAccessToken(req, res) {
  const raw = req.signedCookies?.strava;
  if (!raw) throw new Error("not_authorized");

  let token = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);

  // Ещё валиден
  if (token.expires_at && token.expires_at - 60 > now) {
    return token.access_token;
  }

  // Обновляем
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

  // ✅ те же флаги для кросс-доменной куки
  res.cookie("strava", JSON.stringify(token), {
    httpOnly: true,
    signed: true,
    sameSite: "none",
    secure: true,
    maxAge: 30 * 24 * 3600 * 1000,
    path: "/",
  });

  return token.access_token;
}

/* ---------- 3) Загрузка активностей (пагинация по 30) ---------- */
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

/* ---------- Выход (очистка cookie) ---------- */
app.get("/logout", (req, res) => {
  res.clearCookie("strava", {
    path: "/",
    sameSite: "none",
    secure: true,
    signed: true,
  });
  res.send("Вышли. Cookie очищена.");
});

/* ---------- Старт сервера ---------- */
const PORT = process.env.PORT || 10000; // Render сам пробрасывает порт в PORT
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
