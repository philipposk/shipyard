"use client";

import { useState } from "react";

interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  /** "current-password" on sign-in, "new-password" when choosing one. Helps password managers. */
  autoComplete?: "current-password" | "new-password";
}

export function PasswordInput({
  id,
  value,
  onChange,
  placeholder = "Password",
  required,
  minLength,
  autoComplete = "current-password",
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        name={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        className="input pr-16"
      />
      <button
        type="button"
        className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] px-2 text-sm muted"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}
