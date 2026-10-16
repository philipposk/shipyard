"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_BIO_LENGTH, MAX_DISPLAY_NAME_LENGTH } from "@/lib/validate.mjs";

interface ProfileFormProps {
  initialName: string;
  initialBio: string;
  finished: boolean;
}

export function ProfileForm({ initialName, initialBio, finished }: ProfileFormProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName, bio }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Could not save your profile. Try again.");
        return;
      }
      // Go home and re-read the page from the server so the navigation appears now that the profile is done.
      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div>
        <label htmlFor="name" className="field-label">Display name</label>
        <input
          id="name"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          autoComplete="name"
          required
        />
      </div>
      <div>
        <label htmlFor="bio" className="field-label">Bio</label>
        <textarea
          id="bio"
          className="input"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={MAX_BIO_LENGTH}
          rows={3}
        />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary w-full" disabled={saving}>
        {saving ? "Saving…" : finished ? "Save" : "Save and continue"}
      </button>
    </form>
  );
}
