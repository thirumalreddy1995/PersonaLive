import React, { useState } from 'react';
import { X, ShieldCheck, Mail, Phone, Sparkles } from 'lucide-react';
import { UserAccount } from '../types/index.ts';

interface AccountAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  account: UserAccount;
  onUpdateAccount: (updated: Partial<UserAccount>) => void;
}

export const AccountAuthModal: React.FC<AccountAuthModalProps> = ({
  isOpen,
  onClose,
  account,
  onUpdateAccount,
}) => {
  const [step, setStep] = useState<'profile' | 'otp' | 'tier'>('profile');
  const [email, setEmail] = useState(account.email);
  const [phone, setPhone] = useState(account.phone);
  const fullName = account.fullName;
  const [otpInput, setOtpInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSendOtp = (e: React.FormEvent) => {
    e.preventDefault();
    setStep('otp');
    setMessage(`Verification code dispatched to ${email || phone}. Demo code: 749281`);
  };

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    if (otpInput === '749281' || otpInput.length === 6) {
      onUpdateAccount({
        email,
        phone,
        fullName,
        isAuthenticated: true,
      });
      setMessage('Identity authenticated successfully.');
      setStep('profile');
      setTimeout(() => setMessage(null), 3000);
    } else {
      setMessage('Invalid verification code. Enter demo OTP 749281.');
    }
  };

  const handleSelectTier = (newTier: UserAccount['tier']) => {
    onUpdateAccount({ tier: newTier });
    setMessage(`Subscription updated to ${newTier}. Desktop licence unlocked.`);
    setTimeout(() => setMessage(null), 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-950 border border-sky-800 flex items-center justify-center text-sky-400">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-slate-100">Studio Account & Licence</h2>
              <p className="text-xs text-slate-400">Authentication, OTP verification, and subscription tiers</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Message Banner */}
        {message && (
          <div className="px-6 py-2.5 bg-sky-950/80 border-b border-sky-800 text-sky-300 text-xs flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        <div className="p-6 space-y-5">
          {step === 'profile' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-100 text-sm">{account.fullName}</h3>
                  <p className="text-xs text-slate-400">{account.email}</p>
                  <p className="text-[11px] text-slate-500 font-mono mt-1">Licence: {account.licenseKey}</p>
                </div>
                <div className="text-right">
                  <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-sky-950 text-sky-400 border border-sky-800">
                    {account.tier}
                  </span>
                  <p className="text-[10px] text-slate-500 mt-1">Active until {account.expiresAt}</p>
                </div>
              </div>

              {/* Tiers Switcher */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-300">Select Subscription Tier</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['Free Trial', 'Pro Creator', 'Studio Enterprise'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => handleSelectTier(t)}
                      className={`p-3 rounded-lg border text-left flex flex-col justify-between transition-colors ${
                        account.tier === t
                          ? 'bg-sky-950 border-sky-500 text-sky-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <span className="text-xs font-semibold">{t}</span>
                      <span className="text-[10px] text-slate-500 mt-1">
                        {t === 'Free Trial' ? '$0 / 14 days' : t === 'Pro Creator' ? '$49 / mo' : '$199 / mo'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Phone / Email Update Form */}
              <form onSubmit={handleSendOtp} className="space-y-3 pt-2">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-sky-400" />
                    <span>Registered Email Address</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-sky-400" />
                    <span>Mobile Number (SMS 2FA)</span>
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded text-xs transition-colors"
                >
                  Request SMS / Email OTP Verification
                </button>
              </form>
            </div>
          )}

          {step === 'otp' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="text-center space-y-1">
                <h3 className="font-semibold text-slate-100 text-sm">Enter 6-Digit OTP</h3>
                <p className="text-xs text-slate-400">
                  Verification code sent to {phone || email}
                </p>
              </div>

              <div className="space-y-1">
                <input
                  type="text"
                  maxLength={6}
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value)}
                  placeholder="749281"
                  className="w-full tracking-widest text-center font-mono text-xl bg-slate-950 border border-slate-800 rounded py-3 text-sky-400 focus:outline-none focus:border-sky-500"
                />
                <span className="text-[10px] text-slate-500 block text-center">
                  * For test environment, enter demo code: 749281
                </span>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep('profile')}
                  className="flex-1 py-2 rounded bg-slate-800 text-slate-300 text-xs font-medium"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-bold"
                >
                  Verify OTP Code
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
