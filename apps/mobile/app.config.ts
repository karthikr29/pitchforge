import { ExpoConfig } from "expo/config";
import dotenv from "dotenv";

// Load env from the app folder and repo root so Expo config can see API_BASE_URL, keys, etc.
dotenv.config();
dotenv.config({ path: "../.env" });
dotenv.config({ path: "../../.env" });

const config: ExpoConfig = {
  name: "PitchForge",
  slug: "sales-training",
  scheme: "sales-training",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#0B4F6C"
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.example.salestraining"
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0B4F6C"
    },
    package: "com.example.salestraining"
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/favicon.png"
  },
  plugins: [
    "expo-router"
  ],
  experiments: {
    typedRoutes: true
  },
  extra: {
    eas: {
      projectId: "00000000-0000-0000-0000-000000000000"
    },
    apiBaseUrl: process.env.API_BASE_URL || "http://localhost:54321/functions/v1",
    wsBaseUrl: process.env.WS_BASE_URL || process.env.API_BASE_URL || "http://localhost:54321/functions/v1",
    openaiKey: process.env.OPENAI_API_KEY || "",
    openrouterKey: process.env.OPENROUTER_API_KEY || "",
    claudeKey: process.env.CLAUDE_API_KEY || "",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    minutesEnforcement: process.env.MINUTES_ENFORCEMENT === "true"
  }
};

export default config;

