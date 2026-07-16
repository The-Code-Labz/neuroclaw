/* Security v4 hub — Sentinel · Approvals · Secrets
 *
 * Reuses v2 Sentinel and Approvals, loads the v4 Secrets redesign.
 */
import './../../v2/src/page-sentinel.jsx';
import './../../v2/src/page-approvals.jsx';
import './page-secrets.jsx';

const Security = () => (
  <SubTabs pageId="security" tabs={[
    { id: 'sentinel',  label: 'Sentinel',  render: () => <Sentinel/> },
    { id: 'approvals', label: 'Approvals', render: () => <Approvals/> },
    { id: 'secrets',   label: 'Secrets',   render: () => <Secrets/> },
  ]}/>
);

window.Security = Security;
