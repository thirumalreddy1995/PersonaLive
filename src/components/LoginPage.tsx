import React, { useState } from 'react';
import { Sparkles, Lock, Mail, ShieldCheck, ArrowRight, UserCheck, KeyRound } from 'lucide-react';

interface LoginPageProps {
  onLogin: (email: string, name: string) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('admin@personalive.ai');
  const [password, setPassword] = useState('admin123');
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

    // Default admin or any valid credentials
    const displayName = email.toLowerCase().includes('admin') ? 'Administrator' : email.split('@')[0];
    onLogin(email, displayName);
  };

  const handleQuickAdminLogin = () => {
    setEmail('admin@personalive.ai');
    setPassword('admin123');
    onLogin('admin@personalive.ai', 'Administrator');
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

          {/* Quick 1-Click Admin Login Banner */}
          <div className="bg-sky-950/40 border border-sky-800/80 rounded-xl p-3.5 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-sky-300 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-sky-400" />
                Default Admin Credentials
              </span>
              <span className="text-[10px] bg-sky-900/60 text-sky-300 px-1.5 py-0.5 rounded font-mono">
                Instant Access
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-950/80 p-2.5 rounded-lg border border-slate-800">
              <div>
                <span className="text-slate-500 block text-[10px]">Email:</span>
                <span className="text-slate-200">admin@personalive.ai</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">Password:</span>
                <span className="text-slate-200">admin123</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleQuickAdminLogin}
              className="w-full py-2 px-3 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-all shadow-md shadow-sky-500/20 active:scale-[0.98]"
            >
              <UserCheck className="w-4 h-4" />
              <span>1-Click Sign In as Admin</span>
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
                  placeholder="admin@personalive.ai"
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
              <span className="text-sky-400 hover:underline cursor-pointer">
                Forgot password?
              </span>
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
