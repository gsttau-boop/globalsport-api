import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Проверка работы API
app.get("/", (req, res) => {
  res.send("✅ API Globalsport работает!");
});

// Маршрут авторизации Strava
app.get("/auth/strava", (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;
  const scope = "read,activity:read_all";

  const url = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=force&scope=${scope}`;

  res.redirect(url);
});

// Callback от Strava (временный тестовый ответ)
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code;
  res.send(`✅ Авторизация Strava успешна! Код: ${code}`);
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));
