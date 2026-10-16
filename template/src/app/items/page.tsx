import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { getSessionUser } from "@/lib/session";
import { ItemsClient } from "./items-client";

export const metadata: Metadata = { title: "Items" };

export default async function ItemsPage() {
  const user = await getSessionUser();
  return (
    <AppShell signedIn userLabel={user?.email ?? undefined}>
      <ItemsClient />
    </AppShell>
  );
}
