import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { AppShell } from '@/components/AppShell';
import { SessionProvider, useSessionState } from '@/lib/session';
import Dashboard from '@/routes/Dashboard';
import Boards from '@/routes/Boards';
import Roster from '@/routes/Roster';
import Outreach from '@/routes/Outreach';
import Meetings from '@/routes/Meetings';
import Meeting from '@/routes/Meeting';
import Placeholder from '@/routes/Placeholder';
import Debug from '@/routes/Debug';
import Login from '@/routes/Login';
import AcceptInvite from '@/routes/AcceptInvite';
import Signup from '@/routes/Signup';

// The theme is applied pre-paint by the inline script in index.html, so there
// is deliberately nothing to do here.

/**
 * Gate for everything inside the shell.
 *
 * Renders nothing while the session is still resolving. That blank frame is on
 * purpose: showing the shell first would flash a signed-out visitor the app,
 * and redirecting first would bounce a signed-in one to /login on every reload.
 */
function RequireSession() {
  const { status } = useSessionState();
  if (status === 'loading') return null;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <AppShell />;
}

/**
 * The mirror of RequireSession, for /login and /signup.
 *
 * Without it a signed-in user who navigates to the sign-in page — by habit, by
 * bookmark, or by hitting back — is shown a login form for the account they are
 * already using. There is no error and no way forward that looks different from
 * what they just did, so the honest reading is "it didn't work", and they try
 * again. Sending them to the app instead makes the state legible.
 */
function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { status } = useSessionState();
  if (status === 'loading') return null;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          {/* Outside the shell: neither has a signed-in user, so neither can
              draw a sidebar with a team in it. */}
          <Route
            path="/login"
            element={
              <RedirectIfSignedIn>
                <Login />
              </RedirectIfSignedIn>
            }
          />
          <Route
            path="/signup"
            element={
              <RedirectIfSignedIn>
                <Signup />
              </RedirectIfSignedIn>
            }
          />
          <Route path="/invite/:token" element={<AcceptInvite />} />

          <Route element={<RequireSession />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/boards" element={<Boards />} />
            <Route path="/outreach" element={<Outreach />} />
            <Route path="/roster" element={<Roster />} />
            <Route path="/awards" element={<Placeholder />} />
            <Route path="/portfolio" element={<Placeholder />} />
            <Route path="/calendar" element={<Placeholder />} />
            <Route path="/budget" element={<Placeholder />} />
            <Route path="/meetings" element={<Meetings />} />
            {/* The app's first nested route. AppShell resolves its nav label by
                prefix for this reason — an exact match leaves the mobile title
                bar saying "Coglin" on the screen a student takes notes on. */}
            <Route path="/meetings/:meetingId" element={<Meeting />} />
            <Route path="/debug" element={<Debug />} />
            {/* Any unknown path still renders the shell, which keeps the
                not_found_handling SPA-fallback check meaningful. */}
            <Route path="*" element={<Placeholder />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
