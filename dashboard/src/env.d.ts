/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HUBSPOT_CLIENT_ID: string;
  readonly VITE_HUBSPOT_CLIENT_SECRET: string;
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
} 