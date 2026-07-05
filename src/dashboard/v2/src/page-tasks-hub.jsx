/* Mission Control (CORE) — merged parent for Tasks · Automation · Discipline ·
 * Hive Mind (v3 §1). Sub-views statically imported so they bundle into this
 * chunk (§3.4). */
import './page-tasks.jsx';
import './page-automation.jsx';
import './page-tasks-discipline.jsx';
import './page-hivemind.jsx';

const TasksHub = () => (
  <SubTabs pageId="tasks" tabs={[
    { id: 'tasks',      label: 'Tasks',      render: () => <Tasks/> },
    { id: 'automation', label: 'Automation', render: () => <Automation/> },
    { id: 'discipline', label: 'Discipline', render: () => <BoardDiscipline/> },
    { id: 'hivemind',   label: 'Hive Mind',  render: () => <HiveMind/> },
  ]}/>
);

window.TasksHub = TasksHub;
