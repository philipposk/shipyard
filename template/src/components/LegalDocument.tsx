import { BRAND, CONTACT_EMAIL } from "@/lib/constants";
import { formatLegalDate, resolveController } from "@/lib/legal-helpers.mjs";
import type { LegalController, LegalSection } from "@/lib/legal-types";

interface LegalDocumentProps {
  title: string;
  sections: LegalSection[];
  updatedAt: string;
  controller: LegalController;
}

/**
 * A privacy policy or terms page: who runs the app, a list of links to each part, then the parts.
 * Words come from src/lib/legal-content.ts. Tables scroll sideways on phones instead of squeezing.
 */
export function LegalDocument({ title, sections, updatedAt, controller }: LegalDocumentProps) {
  const who = resolveController(controller, { brandName: BRAND.name, contactEmail: CONTACT_EMAIL });
  const place = [who.address, who.country].filter(Boolean).join(", ");

  return (
    <article className="legal">
      <h1 className="page-title">{title}</h1>
      <p className="muted m-0">Last updated {formatLegalDate(updatedAt)}</p>
      <p className="legal-who">
        Provided by <strong>{who.name}</strong>
        {place ? `, ${place}` : ""}.
        {who.email ? (
          <>
            {" "}
            Contact:{" "}
            <a href={`mailto:${who.email}`} className="link">
              {who.email}
            </a>
            .
          </>
        ) : null}
      </p>

      <nav className="legal-toc" aria-label="On this page">
        <ol>
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="link">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s) => (
        <section key={s.id} aria-labelledby={s.id}>
          <h2 id={s.id}>{s.title}</h2>
          {s.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {s.table ? (
            <div className="legal-table" role="region" aria-label={s.title} tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    {s.table.headers.map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.table.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ))}
    </article>
  );
}
