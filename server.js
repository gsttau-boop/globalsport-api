import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Главная страница API
app.get("/", (req, res) => {
  res.send("✅ API Globalsport работает!");
});

// 🔗 Авторизация Strava
app.get("/auth/strava", (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = "https://globalsport-api.onrender.com/oauth/callback";
  const scope = "read,activity:read_all";

  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=force&scope=${scope}`;
  res.redirect(authUrl);
});

// Callback от Strava
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code;
  res.send(`✅ Авторизация Strava успешна! Код: ${code}`);
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));
