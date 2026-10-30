import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/auth-context";
import { AuthPage } from "./auth/auth-page";
import { AccountPage } from "./account";
import { Foundation } from "./foundation";
import "./auth.css";

function SessionGate() {
  const { loading, error, reload } = useAuth();
  if (loading)
    return (
      <div className="session-state" role="status">
        Opening your space…
      </div>
    );
  if (error)
    return (
      <div className="session-state">
        <h1>Let’s reconnect.</h1>
        <p role="alert">{error}</p>
        <button className="primary-button" onClick={() => void reload()}>
          Try again
        </button>
      </div>
    );
  return <Outlet />;
}

function PrivateRoute() {
  return useAuth().user ? <Outlet /> : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<SessionGate />}>
            <Route
              path="/login"
              element={<AuthPage key="login" mode="login" />}
            />
            <Route
              path="/register"
              element={<AuthPage key="register" mode="register" />}
            />
            <Route element={<PrivateRoute />}>
              <Route path="/" element={<AccountPage />} />
              <Route path="/infrastructure" element={<Foundation />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
