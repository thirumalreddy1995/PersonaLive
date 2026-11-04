import React, { useState } from 'react';
import { Sparkles, Lock, Mail, ShieldCheck, ArrowRight, UserCheck, FlaskConical } from 'lucide-react';

interface LoginPageProps {
  onLogin: (email: string, name: string) => void;
}

/** Identity used by the one-click demo entry; no account exists behind it. */
const DEMO_ADMIN_EMAIL = 'admin@personalive.ai';
const DEMO_ADMIN_NAME = 'Administrator';

/**
 * Demo sign-in gate. Credentials are not verified and never leave the device: any non-empty
 * email/password pair opens the local studio. Replace with real authentication before exposing
 * the app to untrusted users.
 */
export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setErrorMessage('Please enter your email address.');
      return;
    }
    if (!password.trim()) {
      setErrorMessage('Please enter your password.');
      return;
    }

    // Demo gate: nothing is checked beyond the fields being filled in.
    const displayName = email.toLowerCase().includes('admin') ? DEMO_ADMIN_NAME : email.split('@')[0];
    onLogin(email, displayName);
  };

  const handleDemoLogin = () => {
    onLogin(DEMO_ADMIN_EMAIL, DEMO_ADMIN_NAME);
  };

  return (
    <div className="min-h-screen w-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-4 sm:p-8 select-none">
      {/* Top Brand Bar */}
      <div className="flex items-center justify-between max-w-6xl w-full mx-auto">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center text-slate-950 font-black text-sm shadow-md shadow-sky-500/20">
            PL
          </div>
          <div>
            <span className="font-bold text-base tracking-tight text-white flex items-center gap-2">
              PersonaLive
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-sky-950 text-sky-400 border border-sky-800">
                Studio Desktop
              </span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Secure Identity Transformation</span>
        </div>
      </div>

      {/* Main Login Card */}
      <div className="max-w-md w-full mx-auto my-8">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur space-y-6">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center mx-auto">
              <Sparkles className="w-6 h-6" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              Welcome to PersonaLive
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Sign in to start your real-time face transformation studio
            </p>
          </div>

          {/* Demo-mode notice and one-click entry */}
          <div className="bg-amber-950/30 border border-amber-800/70 rounded-xl p-3.5 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                <FlaskConical className="w-3.5 h-3.5 text-amber-400" />
                Demo sign-in
              </span>
              <span className="text-[10px] bg-amber-900/50 text-amber-300 px-1.5 py-0.5 rounded font-mono">
                No account required
              </span>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              This build has no account service. Credentials are not verified and are never sent anywhere;
              the sign-in only unlocks the studio on this device.
            </p>

            <button
              type="button"
              onClick={handleDemoLogin}
              className="w-full py-2 px-3 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-all shadow-md shadow-sky-500/20 active:scale-[0.98]"
            >
              <UserCheck className="w-4 h-4" />
              <span>Continue as demo administrator</span>
            </button>
          </div>

          {/* Standard Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {errorMessage && (
              <div className="p-3 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300 text-xs">
                {errorMessage}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300 block">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="username"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-xl pl-9 pr-3 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none transition-colors"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300 block">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-xl pl-9 pr-3 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none transition-colors"
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-xs pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-slate-400 hover:text-slate-300">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="accent-sky-500 w-3.5 h-3.5 rounded"
                />
                <span>Remember me</span>
              </label>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors border border-slate-700"
            >
              <span>Sign In with Credentials</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          {/* Privacy Note */}
          <p className="text-[11px] text-slate-500 text-center leading-relaxed">
            By signing in, you agree to authorized facial likeness usage terms and certified C2PA provenance standards.
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-slate-600 max-w-md mx-auto">
        PersonaLive Studio Desktop &bull; Version {__PL_APP_VERSION__} &bull; Private & Secure
      </div>
    </div>
  );
};
