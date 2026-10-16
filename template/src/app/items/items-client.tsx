"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { ListSkeleton } from "@/components/LoadingSkeleton";
import { ConfirmModal } from "@/components/ConfirmModal";
import { MAX_ITEM_TITLE_LENGTH, normalizeItemTitle } from "@/lib/validate.mjs";

interface Item {
  id: string;
  title: string;
  created_at: string;
}

/**
 * Example feature: a personal list. Each person only ever sees their own rows, because the database
 * (not this code) enforces it with privacy rules (RLS) in supabase/migrations/0002_items.sql.
 * Copy this pattern for your own tables, and add each new table to supabase/isolation.json.
 */
export function ItemsClient() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState("");
  const [toDelete, setToDelete] = useState<Item | null>(null);

  useEffect(() => {
    let cancelled = false;
    createSupabaseBrowser()
      .from("items")
      .select("id, title, created_at")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setLoadError("Could not load your items. Refresh to try again.");
        else setItems(data ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const clean = normalizeItemTitle(title);
    if (!clean) {
      setFormError(`Enter a title up to ${MAX_ITEM_TITLE_LENGTH} characters.`);
      return;
    }
    setAdding(true);
    try {
      // user_id fills itself in from the signed-in user (default auth.uid() in the database).
      const { data, error } = await createSupabaseBrowser().from("items").insert({ title: clean }).select("id, title, created_at").single();
      if (error || !data) {
        setFormError("Could not add the item. Try again.");
        return;
      }
      setItems((list) => [data, ...list]);
      setTitle("");
    } finally {
      setAdding(false);
    }
  }

  async function deleteItem() {
    if (!toDelete) return;
    const { error } = await createSupabaseBrowser().from("items").delete().eq("id", toDelete.id);
    if (error) {
      setLoadError("Could not delete the item. Try again.");
      return;
    }
    setItems((list) => list.filter((i) => i.id !== toDelete.id));
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Items</h1>
      </div>

      <form onSubmit={addItem} className="flex gap-2 mb-5" noValidate>
        <div className="flex-1 min-w-0">
          <label htmlFor="item-title" className="sr-only">
            New item
          </label>
          <input
            id="item-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add an item"
            maxLength={MAX_ITEM_TITLE_LENGTH}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={adding}>
          {adding ? "Adding…" : "Add"}
        </button>
      </form>
      {formError && <p className="form-error mb-4" role="alert">{formError}</p>}
      {loadError && <p className="form-error mb-4" role="alert">{loadError}</p>}

      {loading ? (
        <ListSkeleton count={3} />
      ) : items.length === 0 ? (
        <div className="card empty-state">
          <p className="m-0 font-semibold">No items yet</p>
        </div>
      ) : (
        <ul className="card list-none m-0 p-0">
          {items.map((item) => (
            <li key={item.id} className="list-row">
              <span className="flex-1 min-w-0 break-words">{item.title}</span>
              <button type="button" className="btn btn-ghost" onClick={() => setToDelete(item)} aria-label={`Delete ${item.title}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        open={toDelete !== null}
        title="Delete this item?"
        message={toDelete ? `"${toDelete.title}" will be gone for good.` : ""}
        confirmLabel="Delete"
        danger
        onConfirm={deleteItem}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
