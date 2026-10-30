import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./auth/auth-context";

export function AccountPage() {
  const { user, signOut } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await signOut();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to sign out. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shell account-shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">▶</span>efiemipeg
          <span className="brand-dot">.</span>
        </Link>
        <div className="workspace-label">YOUR PERSONAL SPACE</div>
        <nav aria-label="Main navigation">
          <a href="#library" className="nav-link">
            <span aria-hidden="true">▦</span> My library
          </a>
          <a href="#profile" className="nav-link">
            <span aria-hidden="true">○</span> My profile
          </a>
          <Link to="/infrastructure" className="nav-link">
            <span aria-hidden="true">◈</span> Infrastructure
          </Link>
        </nav>
        <div className="sidebar-note">
          <span className="small-dot" /> YOUR ACCOUNT
          <p>
            Signed in and ready
            <br />
            for what comes next.
          </p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            Workspace <span>/</span>
            <strong>My library</strong>
          </div>
          <button
            className="refresh signout-button"
            disabled={busy}
            onClick={() => void logout()}
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </header>
        <div className="content">
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">A SPACE TO CALL YOUR OWN</div>
              <h1>
                Welcome, {user.name || "friend"}
                <span>.</span>
              </h1>
              <p>
                Your account is ready. This is where your video library will
                grow.
              </p>
            </div>
            <span className="account-initial" aria-hidden="true">
              {(user.name || user.email).charAt(0).toUpperCase()}
            </span>
          </div>
          <section id="library" className="library-empty">
            <div className="empty-play" aria-hidden="true">
              ▶
            </div>
            <span className="eyebrow">YOUR LIBRARY</span>
            <h2>
              Every collection starts
              <br />
              with a first frame.
            </h2>
            <p>
              You’re all set for the next chapter. Video uploads and playback
              are coming in a future phase.
            </p>
            <span className="coming-badge">Uploads coming next</span>
          </section>
          <section id="profile" className="profile-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">THE PERSON BEHIND THE PLAYLIST</span>
                <h2>Your profile</h2>
              </div>
              <span className="environment">Signed in</span>
            </div>
            <dl className="profile-card">
              <div>
                <dt>Name</dt>
                <dd>{user.name || "Not set"}</dd>
              </div>
              <div>
                <dt>Email address</dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt>Member since</dt>
                <dd>
                  {new Date(user.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </dd>
              </div>
            </dl>
          </section>
          <footer className="footer">
            <span>
              efiemipeg{" "}
              <span className="muted">/ your personal streaming space</span>
            </span>
            <Link to="/infrastructure">Explore the foundation ↗</Link>
          </footer>
        </div>
      </main>
    </div>
  );
}
