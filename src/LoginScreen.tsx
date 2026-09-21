import { useState } from "react";
import { AudioLines, LoaderCircle, LogIn } from "lucide-react";

export default function LoginScreen({
  loading,
  error,
  onLogin,
}: {
  loading: boolean;
  error: string;
  onLogin: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setFormError("");
    try {
      await onLogin();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Unable to start authorization.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark"><AudioLines size={26} /></div>
        <p className="login-kicker">Voice companion</p>
        <h1 id="login-title">Authorize Echo</h1>
        <p className="login-subtitle">Authorize Echo with your Myna account to select a token and voice model.</p>
        <div className="login-form">
          {(formError || error) && <p className="login-error">{formError || error}</p>}
          <button type="button" onClick={() => void submit()} className="login-submit" disabled={loading || submitting}>
            {loading || submitting ? <LoaderCircle size={17} className="animate-spin" /> : <LogIn size={17} />}
            {loading ? "Restoring authorization..." : submitting ? "Waiting for authorization..." : "Authorize with Myna"}
          </button>
        </div>
      </section>
    </main>
  );
}
