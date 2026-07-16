/* v4 Memory hub — uses redesigned v4 Memory page */
import './page-memory.jsx';
import '../../v2/src/page-dream.jsx';
import '../../v2/src/page-rag-docs.jsx';
import '../../v2/src/page-notebooks.jsx';

const MemoryHub = () => (
  <SubTabs pageId="memory" tabs={[
    { id: 'memory',    label: 'Memory',      render: () => <Memory/> },
    { id: 'rag-docs',  label: 'RAG Docs',    render: () => <RAGDocs/> },
    { id: 'notebooks', label: 'Notebooks',   render: () => <Notebooks/> },
    { id: 'dream',     label: 'Dream Cycle', render: () => <Dream/> },
  ]}/>
);

window.MemoryHub = MemoryHub;
