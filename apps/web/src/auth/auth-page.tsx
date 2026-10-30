import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "./api";
import { useAuth } from "./auth-context";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const registering = mode === "register";
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(false);
  if (user) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    setError("");
    setFields({});
    if (registering && password !== form.get("confirmation")) {
      setFields({ confirmation: "Your passwords don’t match." });
      return;
    }
    setBusy(true);
    try {
      await signIn(mode, {
        email: String(form.get("email")),
        password,
        ...(registering ? { name: String(form.get("name")) } : {}),
      });
      navigate("/", { replace: true });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Something went wrong. Please try again.",
      );
      if (cause instanceof ApiError) setFields(cause.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-story" aria-label="About efiemipeg">
        <Link to="/login" className="brand">
          <span className="brand-mark">▶</span>efiemipeg
          <span className="brand-dot">.</span>
        </Link>
        <div className="auth-story-body">
          <span className="hero-tag">YOUR OWN LITTLE CINEMA</span>
          <h1>
            A home for
            <br />
            your next
            <br />
            <span>press of play.</span>
          </h1>
          <p>Your videos. Your space. One personal library to make your own.</p>
          <div className="auth-film" aria-hidden="true">
            <span>01</span>
            <div>▶</div>
            <span>PLAY IT YOUR WAY</span>
          </div>
        </div>
        <p className="auth-story-footer">A personal streaming experiment.</p>
      </section>
      <section className="auth-panel">
        <div className="auth-switch">
          {registering ? "Already have an account?" : "New around here?"}{" "}
          <Link to={registering ? "/login" : "/register"}>
            {registering ? "Sign in" : "Create an account"} ↗
          </Link>
        </div>
        <div className="auth-form-wrap">
          <span className="eyebrow">
            {registering ? "MAKE YOURSELF AT HOME" : "GOOD TO SEE YOU AGAIN"}
          </span>
          <h2>{registering ? "Your space starts here." : "Welcome back."}</h2>
          <p className="auth-subtitle">
            {registering
              ? "Create an account for your personal video library."
              : "Sign in to pick up where you left off."}
          </p>
          <form
            onSubmit={(event) => void submit(event)}
            aria-label={registering ? "Create account" : "Sign in"}
          >
            <fieldset disabled={busy}>
              {registering && (
                <label className="form-field">
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={80}
                    placeholder="What should we call you?"
                    aria-invalid={!!fields.name}
                    aria-describedby={fields.name ? "name-error" : undefined}
                  />
                  {fields.name && (
                    <span id="name-error" className="field-error">
                      {fields.name}
                    </span>
                  )}
                </label>
              )}
              <label className="form-field">
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                  aria-invalid={!!fields.email}
                  aria-describedby={fields.email ? "email-error" : undefined}
                />
                {fields.email && (
                  <span id="email-error" className="field-error">
                    {fields.email}
                  </span>
                )}
              </label>
              <label className="form-field">
                Password
                <div className="password-input">
                  <input
                    name="password"
                    type={visible ? "text" : "password"}
                    autoComplete={
                      registering ? "new-password" : "current-password"
                    }
                    required
                    minLength={registering ? 12 : 1}
                    maxLength={128}
                    placeholder={
                      registering
                        ? "At least 12 characters"
                        : "Enter your password"
                    }
                    aria-invalid={!!fields.password}
                    aria-describedby="password-help"
                  />
                  <button
                    type="button"
                    aria-label={visible ? "Hide password" : "Show password"}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? "Hide" : "Show"}
                  </button>
                </div>
                <span
                  id="password-help"
                  className={fields.password ? "field-error" : "field-hint"}
                >
                  {fields.password ||
                    (registering
                      ? "Use 12–128 characters. A memorable phrase works well."
                      : "")}
                </span>
              </label>
              {registering && (
                <label className="form-field">
                  Confirm password
                  <input
                    name="confirmation"
                    type={visible ? "text" : "password"}
                    autoComplete="new-password"
                    required
                    maxLength={128}
                    placeholder="Once more, just to be sure"
                    aria-invalid={!!fields.confirmation}
                    aria-describedby={
                      fields.confirmation ? "confirmation-error" : undefined
                    }
                  />
                  {fields.confirmation && (
                    <span
                      id="confirmation-error"
                      className="field-error"
                      role="alert"
                    >
                      {fields.confirmation}
                    </span>
                  )}
                </label>
              )}
              {error && (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary-button" type="submit">
                {busy
                  ? registering
                    ? "Creating your account…"
                    : "Signing in…"
                  : registering
                    ? "Create account"
                    : "Sign in"}
                <span aria-hidden="true">→</span>
              </button>
            </fieldset>
          </form>
          <p className="auth-fineprint">
            {registering
              ? "A space of your own, from the very first frame."
              : "Your personal library is just a sign-in away."}
          </p>
        </div>
        <footer className="auth-panel-footer">
          efiemipeg <span>Built to learn. Ready to grow.</span>
        </footer>
      </section>
    </div>
  );
}
