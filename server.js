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

// 1) Старт авторизации
app.get("/auth/strava", (req, res) => {
  if (!STRAVA_CLIENT_ID || !STRAVA_REDIRECT_URI) {
    return res.status(500).send("STRAVA_CLIENT_ID/STRAVA_REDIRECT_URI не заданы в окружении");
  }

  // откуда нас вызвали (например, https://globalsport.kz/challenge)
  const next = typeof req.query.next === "string" && req.query.next.startsWith("http")
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
    `&state=${encodeURIComponent(next)}`;   // <— ВАЖНО

  res.redirect(url);
});

// ... всё как у вас выше

// 2) Callback
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

    const token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      athlete_id: data.athlete?.id,
    };

    res.cookie("strava", JSON.stringify(token), {
      httpOnly: true,
      signed: true,
      sameSite: "None",  // для кросс-домена
      secure: true,      // обязателен при SameSite=None
      maxAge: 30 * 24 * 3600 * 1000,
    });

    // Куда вернуть пользователя
    const next = typeof req.query.state === "string" && req.query.state.startsWith("http")
      ? decodeURIComponent(req.query.state)
      : `${FRONTEND_URL}/challenge`;

    // Можно прокинуть флажок об успешном коннекте
    return res.redirect(`${next}?connected=1`);
  } catch (e) {
    console.error("TOKEN EXCHANGE ERROR:", e.response?.data || e.message);

    const next = typeof req.query.state === "string" && req.query.state.startsWith("http")
      ? decodeURIComponent(req.query.state)
      : `${FRONTEND_URL}/challenge`;

    // Вернёмся на фронт с ошибкой
    return res.redirect(`${next}?error=strava_token`);
  }
});


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
