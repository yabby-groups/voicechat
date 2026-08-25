import { useState, type FormEvent } from "react";
import { AudioLines, LoaderCircle, LockKeyhole } from "lucide-react";

export default function LoginScreen({
  loading,
  error,
  onLogin,
}: {
  loading: boolean;
  error: string;
  onLogin: (name: string, password: string, totpCode: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      await onLogin(name, password, totpCode);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unable to sign in.";
      if (message === "totp required" || message === "totp invalid") setTotpRequired(true);
      setFormError(message === "totp required" ? "Enter the current six-digit authenticator code." : message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark"><AudioLines size={26} /></div>
        <p className="login-kicker">Voice companion</p>
        <h1 id="login-title">Sign in to Echo</h1>
        <p className="login-subtitle">Use your Myna account to select a token and voice model.</p>
        <form onSubmit={submit} className="login-form">
          <label>
            <span>Account</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="username" required />
          </label>
          <label>
            <span>Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {totpRequired && (
            <label>
              <span>Authenticator code</span>
              <input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
            </label>
          )}
          {(formError || error) && <p className="login-error">{formError || error}</p>}
          <button type="submit" className="login-submit" disabled={loading || submitting}>
            {loading || submitting ? <LoaderCircle size={17} className="animate-spin" /> : <LockKeyhole size={17} />}
            {loading ? "Restoring session..." : submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
