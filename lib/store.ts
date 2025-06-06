import { create } from "zustand";
import type { AppState, ChatMessage, Balance, ViewingKeys } from "./types";
import {
  saveChatMessages,
  loadChatMessages,
  loadViewingKeys,
  saveViewingKeys,
} from "./localStorage";
import {
  setupKeplr,
  formatAmount,
  secretLCDClient,
  getSnip20Balance,
} from "./utils";
import { SSCRT_ADDRESS, SUSDC_ADDRESS, SUSDC_VIEWING_KEY } from "./constants";
import { SSCRT_VIEWING_KEY } from "./constants";
import { getAuthToken, getWalletAddressFromToken, isTokenExpired, loginWithKeplr, logout } from "@/utils/auth";

interface AppStore extends AppState {
  // Wallet actions
  getAutoConnect: () => boolean;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;

  // Balance actions
  updateBalances: (balances: Balance) => void;
  fetchBalances: () => Promise<void>;
  fetchUser: (token?: string) => Promise<void>;
  fetchAgentAddress: () => Promise<void>;
  authorizeSpend: () => Promise<void>;

  // Viewing key actions
  setViewingKeys: (viewingKeys: ViewingKeys) => void;
  loadViewingKeys: () => Promise<void>;

  // Chat actions
  addMessage: (content: string, role: "user" | "assistant") => Promise<void>;
  loadMessages: () => Promise<void>;
  clearMessages: () => void;

  // Trade actions
  setConvinced: (convinced: boolean) => void;
  startTrading: () => Promise<void>;

  // UI actions
  setLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  // Initial state
  user: null,
  token: null,
  agentAddress: null,
  wallet: {
    isConnected: false,
    secretAddress: "",
    secretSigner: undefined,
    secretChain: undefined,
  },
  balances: {
    sSCRT: "0",
    sUSDC: "0",
    nobleUSDC: "0",
  },
  viewingKeys: null,
  messages: [],
  trade: {
    isConvinced: false,
    isTrading: false,
  },
  isLoading: false,

  getAutoConnect: () => {
    return localStorage.getItem("keplrAutoConnect") === "true";
  },

  // Wallet actions
  connectWallet: async () => {
    set({ isLoading: true });
    try {
      if (!window.keplr) {
        console.warn("Please install Keplr extension to continue.");
        return;
      }
      const { secretAddress, secretSigner, secretChain } = await setupKeplr();

      let existingToken = getAuthToken();
      const walletAddress = getWalletAddressFromToken();

      if (existingToken && walletAddress && isTokenExpired(existingToken)) {
        logout();
        existingToken = null;
      }

      if (!existingToken) {
        const data = await loginWithKeplr();
        const { data: { user, token } } = data;
        set({ user, token });
        existingToken = token;
      }

      const payload = {
        token: existingToken,
        wallet: {
          isConnected: true,
          secretAddress,
          secretSigner,
          secretChain,
        }
      }
      set(payload);
      await get().fetchUser(existingToken);
      await get().fetchAgentAddress();
      get().loadViewingKeys();
      localStorage.setItem("keplrAutoConnect", "true");
    } catch (error) {
      alert("Session expired. Logging out.");
      get().disconnectWallet();
    } finally {
      set({ isLoading: false });
    }
  },

  authorizeSpend: async () => {
    const { token, wallet, agentAddress } = get();
    const { secretSigner, secretAddress } = wallet

    if (!token || !wallet.isConnected || !secretSigner || !secretAddress || !agentAddress) {
      throw new Error("No token or wallet found");
    }

    const lcdClient = secretLCDClient(secretAddress, secretSigner);
    await lcdClient.tx.snip20.increaseAllowance({
      sender: secretAddress,
      contract_address: SSCRT_ADDRESS,
      msg: {
        increase_allowance: {
          spender: agentAddress,
          amount: "8000000"
        }
      }
    }, {
      gasLimit: 5_000_000,
    },)
    await lcdClient.tx.snip20.increaseAllowance({
      sender: secretAddress,
      contract_address: SUSDC_ADDRESS,
      msg: {
        increase_allowance: {
          spender: agentAddress,
          amount: "8000000"
        }
      }
    }, {
      gasLimit: 5_000_000,
    },)


    const response = await fetch("/api/user/authorize_spend", {
      headers: {
        "Authorization": `Bearer ${token}`,
      }
    });
    if (!response.ok) {
      throw new Error("Failed to authorize spend");
    }

    await get().fetchUser(token);
  },

  disconnectWallet: () => {
    set({
      user: null,
      token: null,
      wallet: {
        isConnected: false,
        secretAddress: "",
        secretSigner: undefined,
        secretChain: undefined,
      },
      balances: {
        sSCRT: "0",
        sUSDC: "0",
      },
      trade: {
        isConvinced: false,
        isTrading: false,
      },
    });
    logout()
  },

  // Viewing key actions
  setViewingKeys: async (viewingKeys: ViewingKeys) => {
    try {
      const { token } = get();
      if (!token || !viewingKeys) {
        throw new Error("User or viewing keys not found");
      }
      const { sSCRT, sUSDC } = viewingKeys;
      const payload = {
        sscrtKey: sSCRT,
        susdcKey: sUSDC,
      }
      const response = await fetch("/api/user/keys", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error("Failed to set viewing keys");
      }
      const data = await response.json();
      console.log(data);
      saveViewingKeys(viewingKeys);
      set({ viewingKeys });
    } catch (error) {
      alert("Failed to set viewing keys");
    }
  },

  loadViewingKeys: async () => {
    const viewingKeys = loadViewingKeys();
    if (viewingKeys) {
      set({ viewingKeys });
    }
  },
  // Balance actions
  updateBalances: (balances: Balance) => {
    set({ balances });
  },

  fetchUser: async (token?: string) => {
    const { token: _token } = get()
    const tokenToUse = _token || token;
    if (!tokenToUse) {
      throw new Error("No token found");
    }

    const response = await fetch("/api/user/info", {
      headers: {
        "Authorization": `Bearer ${tokenToUse}`,
      }
    });
    if (!response.ok) {
      throw new Error("Failed to fetch user");
    }
    const { data } = await response.json();
    console.log("data", data);
    set({ user: data });
  },

  fetchAgentAddress: async () => {
    const { token, wallet } = get();
    if (!token || !wallet.isConnected) {
      throw new Error("No token or wallet found");
    }
    const response = await fetch("/api/agent/address", {
      headers: {
        "Authorization": `Bearer ${token}`,
      }
    });
    if (!response.ok) {
      throw new Error("Failed to fetch agent address");
    }
    const { data } = await response.json();
    set({ agentAddress: data });
  },

  fetchBalances: async () => {
    const { wallet, viewingKeys } = get();
    if (!wallet.isConnected || !viewingKeys) return;

    set({ isLoading: true });
    try {
      // Simulate API call
      const { secretSigner, secretChain, secretAddress } = wallet;

      if (!secretChain || !secretSigner || !secretAddress) {
        throw new Error("Wallet is not connected");
      }

      const lcdClient = secretLCDClient(secretAddress, secretSigner);

      const sscrtCoinBalance = await getSnip20Balance(
        SSCRT_ADDRESS,
        viewingKeys.sSCRT,
        lcdClient,
        secretAddress,
      );
      const sscrtCoinFormattedBal = formatAmount(sscrtCoinBalance, 6);

      const sUSDCBalance = await getSnip20Balance(
        SUSDC_ADDRESS,
        viewingKeys.sUSDC,
        lcdClient,
        secretAddress,
      );
      const sUSDCFormattedBal = formatAmount(sUSDCBalance, 6);

      const mockBalances = {
        sSCRT: sscrtCoinFormattedBal.toString(),
        sUSDC: sUSDCFormattedBal.toString(),
      };

      set({ balances: mockBalances, isLoading: false });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  // Chat actions
  addMessage: async (content: string, role: "user" | "assistant") => {
    const { token, user, wallet } = get();
    if (!token || !user || !wallet.isConnected) {
      throw new Error("No token or user or wallet found");
    }
    const newMessage: ChatMessage = {
      content,
      role,
    };

    const { messages } = get();
    const updatedMessages = [...messages, newMessage];

    set({ messages: updatedMessages });
    
    const response = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: content }),
      headers: {
        "Authorization": `Bearer ${token}`,
      }
    });

    if (!response.ok) {
      throw new Error("Failed to add message");
    }
    const { data } = await response.json();
    const aiRes: ChatMessage = {
      role: "assistant",
      content: data.response,
    } as ChatMessage
    set({ messages: [...updatedMessages, aiRes] });
  },

  loadMessages: async () => {
    const { user, wallet, token } = get();
    if (!user || !wallet.isConnected || !token) {
      return
    }
    const response = await fetch("/api/chat", {
      headers: {
        "Authorization": `Bearer ${token}`,
      }
    });
    if (!response.ok) {
      throw new Error("Failed to load messages");
    }
    const { data } = await response.json();
    console.log("data", data);
    set({ messages: data });
  },

  clearMessages: () => {
    set({ messages: [] });
    saveChatMessages([]);
  },

  // Trade actions
  setConvinced: (convinced: boolean) => {
    set((state) => ({
      trade: { ...state.trade, isConvinced: convinced },
    }));
  },

  startTrading: async () => {
    set((state) => ({
      trade: { ...state.trade, isTrading: true },
      isLoading: true,
    }));

    try {
      // Simulate trading
      await new Promise((resolve) => setTimeout(resolve, 3000));

      set((state) => ({
        trade: {
          ...state.trade,
          isTrading: false,
          lastTradeResult:
            "Trade executed successfully! Bought 10 SCRT with 50 sUSDC",
        },
        isLoading: false,
      }));

      // Refresh balances
      get().fetchBalances();
    } catch (error) {
      set((state) => ({
        trade: { ...state.trade, isTrading: false },
        isLoading: false,
      }));
      throw error;
    }
  },

  // UI actions
  setLoading: (loading: boolean) => {
    set({ isLoading: loading });
  },
}));
