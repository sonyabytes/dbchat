export {};

declare global {
  interface DbchatUpdateState {
    status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
    current: string;
    latest?: { version: string; notes: string; url: string };
    progress?: number;
    error?: string;
  }

  interface Window {
    dbchat?: {
      serverUrl?: string;
      platform: string;
      isElectron: boolean;
      canCheckForUpdates: boolean;
      checkForUpdates: () => Promise<void>;
      updater?: {
        getState: () => Promise<DbchatUpdateState | undefined>;
        check: () => Promise<void>;
        download: () => Promise<void>;
        install: () => Promise<void>;
        onChange: (cb: (state: DbchatUpdateState) => void) => () => void;
      };
    };
  }
}
