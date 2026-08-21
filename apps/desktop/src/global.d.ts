interface Window {
  dbchat?: {
    serverUrl?: string;
    platform: string;
    isElectron: boolean;
    canCheckForUpdates: boolean;
    checkForUpdates: () => Promise<void>;
  };
}
