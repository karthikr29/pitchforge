/**
 * CLI ingestion script (admin-only).
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ts-node tools/ingest.ts --company <uuid>
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const bucket = "company-docs";

type Args = { company: string; dir: string };

function parseArgs(): Args {
  const companyIdx = process.argv.indexOf("--company");
  const dirIdx = process.argv.indexOf("--dir");
  const company = companyIdx > -1 ? process.argv[companyIdx + 1] : "";
  const dir = dirIdx > -1 ? process.argv[dirIdx + 1] : "./uploads";
  if (!company) throw new Error("--company is required");
  return { company, dir };
}

const chunkText = (text: string, size = 800) => {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
};

async function embed(text: string) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text })
  });
  if (!res.ok) throw new Error("Embedding failed");
  const json = await res.json();
  return json.data[0].embedding as number[];
}

async function main() {
  const { company, dir } = parseArgs();
  const supabase = createClient(supabaseUrl, supabaseKey);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt") || f.endsWith(".pdf"));
  for (const file of files) {
    const full = path.join(dir, file);
    const content = fs.readFileSync(full, "utf8"); // For PDFs replace with pdf parser
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        company_id: company,
        title: file,
        source_path: `${bucket}/${company}/${file}`,
        status: "processed"
      })
      .select()
      .single();

    const chunks = chunkText(content);
    for (const [idx, chunk] of chunks.entries()) {
      const embedding = await embed(chunk);
      await supabase.from("document_chunks").insert({
        document_id: doc.id,
        company_id: company,
        chunk_index: idx,
        content: chunk,
        embedding
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

