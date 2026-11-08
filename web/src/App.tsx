import { useEffect, useState } from 'react';
import { parseRoute, useHash } from './lib/route';
import { Icon } from './components/Icon';
import { IconButton } from './components/Controls';
import { DialogHost, ToastHost } from './components/Feedback';
import { DrawerHost } from './components/Drawers';
import { PullsView } from './views/PullsView';
import { PullView } from './views/PullView';
import { TicketsView } from './views/TicketsView';

function useCollapsed(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem('sidebarCollapsed') === '1'; } catch { return false; } });
  const set = (v: boolean) => { setOn(v); try { localStorage.setItem('sidebarCollapsed', v ? '1' : '0'); } catch { /* ignore */ } };
  return [on, set];
}

export function App() {
  const route = parseRoute(useHash());
  const [collapsed, setCollapsed] = useCollapsed();

  // a new page starts at the top (moving between findings of one PR does not)
  const pageKey = route.name === 'pr' ? `pr-${route.id}` : route.name;
  useEffect(() => { window.scrollTo(0, 0); }, [pageKey]);

  const nav = route.name === 'pr' ? 'pulls' : route.name;
  const link = (name: 'pulls' | 'tickets', href: string, icon: 'pulls' | 'board', label: string) => (
    <a href={href} className={nav === name ? 'on' : ''} aria-current={nav === name ? 'page' : undefined}>
      <Icon name={icon} /><span className="lbl-full">{label}</span>
    </a>
  );

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar" aria-label="Main">
        <div className="side-head">
          <a className="brand" href="#/"><span className="brand-mark"><Icon name="brand" /></span><span className="brand-name">PR Quality Gate</span></a>
          <IconButton icon="left" className={`collapse-btn${collapsed ? ' flip' : ''}`} label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} onClick={() => setCollapsed(!collapsed)} />
        </div>
        <nav className="side-nav">
          {link('pulls', '#/', 'pulls', 'Pull requests')}
          {link('tickets', '#/tickets', 'board', 'Ticket board')}
        </nav>
      </aside>
      <main className="main">
        <div className="page" id="app" aria-live="polite">
          {route.name === 'pr' ? <PullView key={route.id} id={route.id} f={route.f} />
            : route.name === 'tickets' ? <TicketsView prParam={route.pr} />
            : <PullsView />}
        </div>
      </main>
      <DrawerHost />
      <DialogHost />
      <ToastHost />
    </div>
  );
}
