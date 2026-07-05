/* Memory (MIND) — merged parent for Memory · RAG Docs · Dream (v3 §1).
 * Memory + RAG are Supabase pgvector-backed; the legacy Obsidian Vault is cut.
 * Sub-views statically imported so they bundle into this chunk (§3.4). */
import './page-memory.jsx';
import './page-dream.jsx';
import './page-rag-docs.jsx';

const MemoryHub = () => (
  <SubTabs pageId="memory" tabs={[
    { id: 'memory', label: 'Memory', render: () => <Memory/> },
    { id: 'rag-docs', label: 'RAG Docs', render: () => <RAGDocs/> },
    { id: 'dream',  label: 'Dream Cycle', render: () => <Dream/> },
  ]}/>
);

window.MemoryHub = MemoryHub;
