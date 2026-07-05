/* Agents (CORE) — merged parent for Agents · Comms · Hive Mind (v3 §1).
 * Sub-views statically imported so they bundle into this chunk (§3.4). */
import './page-agents.jsx';
import './page-comms.jsx';
import './page-hivemind.jsx';

const AgentsHub = () => (
  <SubTabs pageId="agents" tabs={[
    { id: 'agents',   label: 'Agents',    render: () => <Agents/> },
    { id: 'comms',    label: 'Comms',     render: () => <Comms/> },
    { id: 'hivemind', label: 'Hive Mind', render: () => <HiveMind/> },
  ]}/>
);

window.AgentsHub = AgentsHub;
