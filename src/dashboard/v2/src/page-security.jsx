/* Security (SYSTEM) — merged parent for Sentinel · Approvals · Secrets (v3 §1).
 * Sub-views statically imported so they bundle into this chunk (§3.4). */
import './page-sentinel.jsx';
import './page-approvals.jsx';
import './page-secrets.jsx';

const Security = () => (
  <SubTabs pageId="security" tabs={[
    { id: 'sentinel',  label: 'Sentinel',  render: () => <Sentinel/> },
    { id: 'approvals', label: 'Approvals', render: () => <Approvals/> },
    { id: 'secrets',   label: 'Secrets',   render: () => <Secrets/> },
  ]}/>
);

window.Security = Security;
