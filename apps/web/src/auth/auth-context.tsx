import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, type User } from "./api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  signIn: (
    mode: "login" | "register",
    input: { email: string; password: string; name?: string },
  ) => Promise<void>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const id = ++generation.current;
    try {
      const result = await api<{ user: User }>("/auth/me");
      if (generation.current === id) {
        setUser(result.user);
        setError("");
      }
    } catch (cause) {
      if (generation.current !== id) return;
      if (cause instanceof ApiError && cause.status === 401) {
        setUser(null);
        setError("");
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load your account.",
        );
    } finally {
      if (generation.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => {
      void reload();
    };
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(onFocus, 30000);
    return () => {
      generation.current++;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [reload]);

  const signIn: AuthContextValue["signIn"] = async (mode, input) => {
    ++generation.current;
    const result = await api<{ user: User }>(`/auth/${mode}`, input);
    ++generation.current;
    setUser(result.user);
    setError("");
    setLoading(false);
  };

  const signOut = async () => {
    ++generation.current;
    try {
      await api("/auth/logout", {});
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
    }
    ++generation.current;
    setUser(null);
    setError("");
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, error, reload, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("AuthProvider is required");
  return context;
}
