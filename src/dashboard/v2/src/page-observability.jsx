/* Observability — merged parent for Analytics · Usage · Health · Logs (v3 §1).
 *
 * Statically imports its sub-views so Vite bundles them into THIS chunk (§3.4)
 * — they must NOT also be lazy-loaded from app.jsx's PAGES map, or Vite emits
 * them twice. Each sub-view renders its own PageHeader; SubTabs supplies the
 * segmented bar and only mounts the active tab's body. */
import './page-analytics.jsx';
import './page-usage.jsx';
import './page-health.jsx';
import './page-logs.jsx';

const Observability = () => (
  <SubTabs pageId="observability" tabs={[
    { id: 'analytics', label: 'Analytics', render: () => <Analytics/> },
    { id: 'usage',     label: 'Usage',     render: () => <Usage/> },
    { id: 'health',    label: 'Health',    render: () => <Health/> },
    { id: 'logs',      label: 'Logs',      render: () => <Logs/> },
  ]}/>
);

window.Observability = Observability;
