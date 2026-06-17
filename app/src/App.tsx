import { useState, useEffect, lazy, Suspense } from "react";
import type { ComponentType } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { ThemeProvider } from 'next-themes';
import { HeroUIProvider } from '@heroui/react';
import type { InspectParams } from 'react-dev-inspector';
import './styles/github-markdown.css';
import 'react-photo-view/dist/react-photo-view.css';
import '@/lib/i18n';
import { initStore } from '@/store/init';
import { CommonLayout } from '@/components/Layout';
import { AppProvider } from '@/store/module/AppProvider';
import { BlinkoraMultiSelectPop } from '@/components/BlinkoraMultiSelectPop';
import { LoadingPage } from '@/components/Common/LoadingPage';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';
import { getTokenData, setNavigate } from '@/components/Auth/auth-client';
import { BlinkoraStore } from '@/store/blinkoraStore';

const HomePage = lazy(() => import('./pages/index'));
const SignInPage = lazy(() => import('./pages/signin'));
const SignUpPage = lazy(() => import('./pages/signup'));
const ResourcesPage = lazy(() => import('./pages/resources'));
const ReviewPage = lazy(() => import('./pages/review'));
const SettingsPage = lazy(() => import('./pages/settings'));
const DetailPage = lazy(() => import('./pages/detail'));

const DevInspector = () => {
  const [InspectorComponent, setInspectorComponent] = useState<ComponentType<any> | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    import('react-dev-inspector').then(({ Inspector }) => {
      setInspectorComponent(() => Inspector);
    });
  }, []);

  if (!InspectorComponent) return null;

  return (
    <InspectorComponent
      keys={['control', 'alt', 'x']}
      onClickElement={({ codeInfo }: InspectParams) => {
        if (!codeInfo?.absolutePath) return
        const { absolutePath, lineNumber, columnNumber } = codeInfo
        window.open(`cursor://file/${absolutePath}:${lineNumber}:${columnNumber}`)
      }}
    />
  );
};

const ScrollbarActivityTracker = () => {
  useEffect(() => {
    const root = document.documentElement;
    let hideTimer: number | undefined;
    const listenerOptions: AddEventListenerOptions = { capture: true, passive: true };

    const showScrollbar = () => {
      root.classList.add('scrollbar-active');
      if (hideTimer) {
        window.clearTimeout(hideTimer);
      }
      hideTimer = window.setTimeout(() => {
        root.classList.remove('scrollbar-active');
      }, 1000);
    };

    window.addEventListener('scroll', showScrollbar, listenerOptions);
    window.addEventListener('wheel', showScrollbar, listenerOptions);
    window.addEventListener('touchmove', showScrollbar, listenerOptions);

    return () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
      }
      root.classList.remove('scrollbar-active');
      window.removeEventListener('scroll', showScrollbar, listenerOptions);
      window.removeEventListener('wheel', showScrollbar, listenerOptions);
      window.removeEventListener('touchmove', showScrollbar, listenerOptions);
    };
  }, []);

  return null;
};

const HomeRedirect = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const blinkora = RootStore.Get(BlinkoraStore);
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const redirectToDefaultPage = async () => {
      await blinkora.config.call();
      const defaultHomePage = blinkora.config.value?.defaultHomePage;
      const currentPath = searchParams.get('path');
      const isDirectNavigation = location.key === 'default';
      if (currentPath || !defaultHomePage || defaultHomePage === 'blinkora' || !isDirectNavigation) {
        setLoading(false);
        return;
      }
      
      navigate(`/?path=${defaultHomePage}`, { replace: true });
    };
    
    redirectToDefaultPage();
  }, [navigate, searchParams, location]);
  
  if (loading) {
    return <LoadingPage />;
  }
  
  return <HomePage />;
};

const ProtectedRoute = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isChecking, setIsChecking] = useState(true);
  const userStore = RootStore.Get(UserStore);

  useEffect(() => {
    setNavigate(navigate);
  }, [navigate]);

  useEffect(() => {
    const checkAuth = async () => {
      const publicRoutes = ['/signin', '/signup'];
      const isPublicRoute = publicRoutes.some(route => location.pathname === route);
      if (!userStore.isLogin && !isPublicRoute) {
        const tokenData = await getTokenData();
        console.log('tokenData', tokenData);

        if (!tokenData?.user?.id) {
          console.log('No valid token, redirecting to login page');
          navigate('/signin', { replace: true });
        }
      }

      setIsChecking(false);
    };

    checkAuth();
  }, [userStore.isLogin]);

  if (isChecking) {
    return <LoadingPage />;
  }

  return children;
};

function AppRoutes() {
  return (
    <Suspense fallback={<LoadingPage />}>
      <Routes>
        <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/resources" element={<ProtectedRoute><ResourcesPage /></ProtectedRoute>} />
        <Route path="/review" element={<ProtectedRoute><ReviewPage /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        <Route path="/detail/*" element={<ProtectedRoute><DetailPage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function App() {
  initStore();

  return (
    <>
      {import.meta.env.DEV && <DevInspector />}
      <BrowserRouter>
        <HeroUIProvider>
          <ThemeProvider attribute="class" enableSystem={false}>
            <ScrollbarActivityTracker />
            <AppProvider />
            <CommonLayout>
              <div className="app-content">
                <AppRoutes />
                <BlinkoraMultiSelectPop />
              </div>
            </CommonLayout>
          </ThemeProvider>
        </HeroUIProvider>
      </BrowserRouter>
    </>
  );
}

export default App;
