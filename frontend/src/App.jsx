import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import {
  Activity, ShieldAlert, Cpu, CircleDollarSign, Terminal,
  Settings, LineChart as LineChartIcon, RefreshCw, LogOut, Plus, Trash2,
  Play, Square, AlertCircle, Ban, Server, Compass, Sparkles,
  TrendingUp, Zap, Target, ShieldCheck, Gauge, BarChart3, Clock, DollarSign,
  UserPlus, ExternalLink, CheckCircle2, X, Key, Globe, SlidersHorizontal, Timer
} from 'lucide-react';

const MuiLineChart = lazy(() =>
  import('@mui/x-charts/LineChart').then((module) => ({ default: module.LineChart }))
);

const CONFIGURED_BACKEND = import.meta.env.VITE_BACKEND_URL;

const isLanHostname = (h) => {
  if (!h) return false;
  return h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    h.startsWith('192.168.') ||
    h.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
};

const resolveDefaultBackend = () => {
  if (CONFIGURED_BACKEND) return CONFIGURED_BACKEND;
  if (typeof window === 'undefined') return 'http://localhost:3001';
  
  const { hostname, port, protocol, origin } = window.location;
  if (port === '3001') {
    return origin;
  }
  if (port === '5173' || port === '5174') {
    return `${protocol}//${hostname}:3001`;
  }
  if (isLanHostname(hostname)) {
    return `${protocol}//${hostname}:3001`;
  }
  return "https://kickbacks-backend-node-1.onrender.com";
};

const DEFAULT_INSTANCES = [
  "https://kickbacks-backend-node-1.onrender.com",
  "https://kickbacks-backend-node-2.onrender.com",
  "https://kickbacks-backend-node-3.onrender.com",
  "https://kickbacks-backend-node-4.onrender.com",
  "https://kickbacks-backend-node-5.onrender.com",
  "https://kickbacks-backend-node-6.onrender.com",
  "https://kickbacks-backend-node-7.onrender.com",
  "https://kickbacks-backend-node-8.onrender.com",
  "https://kickbacks-backend-node-9.onrender.com",
  "https://kickbacks-backend-node-10.onrender.com"
];

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'analytics', label: 'Analytics', icon: LineChartIcon },
  { id: 'config', label: 'Control', icon: Settings },
  { id: 'logs', label: 'Logs', icon: Terminal }
];

const TAB_TITLES = {
  dashboard: 'Fleet command',
  analytics: 'Revenue trace',
  config: 'Control settings',
  logs: 'Live terminal'
};

export default function App() {
  const [password, setPassword] = useState(localStorage.getItem('dashboard_password') || '');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authChecking, setAuthChecking] = useState(false);

  const [instances, setInstances] = useState(() => {
    const isLocal = typeof window !== 'undefined' && isLanHostname(window.location.hostname);
    const resolvedDefault = resolveDefaultBackend();
    const defaultList = [resolvedDefault];
    const saved = localStorage.getItem('dashboard_instances');
    let list = saved ? JSON.parse(saved) : defaultList;
    list = list.filter(item => !item.includes('utksh.in') && !item.includes('utksh.bar') && !item.includes('kickbacks-backend-nbah.onrender.com') && !item.includes('kickbacks-backend-6big.onrender.com') && !item.match(/:(300[2-9]|3010)/));
    if (!isLocal) {
      // In production (e.g. Vercel), strip plain localhost/http URLs to avoid mixed content errors
      list = list.filter(item => !item.includes('localhost') && !item.includes('127.0.0.1'));
    }
    if (resolvedDefault && !list.includes(resolvedDefault)) {
      list.unshift(resolvedDefault);
    }
    if (!list || list.length === 0) {
      list = [...defaultList];
    }
    return list;
  });
  const [newUrl, setNewUrl] = useState('');

  const [activeTab, setActiveTab] = useState('dashboard');
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(() => Boolean(localStorage.getItem('dashboard_password')));
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [selectedAccount, setSelectedAccount] = useState('all');

  // Derive list of individual accounts across backend instances
  const displayedAccounts = useMemo(() => {
    const list = [];
    Object.keys(statuses).forEach(url => {
      const s = statuses[url];
      if (!s || !s.online) return;

      const configProfs = Array.isArray(s.configProfiles) ? s.configProfiles : [];
      const runtimeProfs = Array.isArray(s.profiles) ? s.profiles : [];

      const names = Array.from(new Set([
        ...configProfs.map(p => p.name).filter(Boolean),
        ...runtimeProfs.map(p => p.name).filter(Boolean)
      ]));

      names.forEach((accName, accIndex) => {
        const cfg = configProfs.find(p => p.name === accName) || {};
        const rt = runtimeProfs.find(p => p.name === accName) || {};
        const profile = { ...cfg, ...rt };
        const clients = (s.clients || []).filter(c => 
          c.name.startsWith(accName) || 
          (names.length === 1 && !c.name.includes('account_'))
        );
        list.push({
          id: `${url}-${accName}`,
          url,
          name: accName,
          accIndex,
          profile,
          config: cfg,
          scale: cfg.scale || 10,
          minPromptWait: cfg.minPromptWait || 8,
          maxPromptWait: cfg.maxPromptWait || 15,
          sessionDuration: cfg.sessionDuration || 60,
          clients,
          isOnline: s.online,
          isRunning: s.running,
          isSimulated: Boolean(cfg.isSimulated || cfg.simulated || cfg.refreshToken?.startsWith('simulated_'))
        });
      });
    });
    return list;
  }, [statuses]);

  // Account Connect Modal & Auth States
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectTab, setConnectTab] = useState('google');
  const [authSession, setAuthSession] = useState(null);
  const [authStatus, setAuthStatus] = useState('idle');
  const [authErrorMsg, setAuthErrorMsg] = useState('');
  const [googleScale, setGoogleScale] = useState(10);

  const [manualAccountName, setManualAccountName] = useState('');
  const [manualRefreshToken, setManualRefreshToken] = useState('');
  const [manualScale, setManualScale] = useState(10);
  const [manualMinWait, setManualMinWait] = useState(8);
  const [manualMaxWait, setManualMaxWait] = useState(15);
  const [manualSessionDuration, setManualSessionDuration] = useState(60);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualErrorMsg, setManualErrorMsg] = useState('');
  const [manualSuccessMsg, setManualSuccessMsg] = useState('');

  // Simulated Account State
  const [simulatedName, setSimulatedName] = useState('');
  const [simulatedScale, setSimulatedScale] = useState(10);
  const [simulatedSaving, setSimulatedSaving] = useState(false);
  const [simulatedErrorMsg, setSimulatedErrorMsg] = useState('');

  // Real-Time Bot Scaling State
  const [scalingAccountName, setScalingAccountName] = useState(null);
  const [fleetScaleInput, setFleetScaleInput] = useState(10);
  const [fleetScaleSaving, setFleetScaleSaving] = useState(false);

  // Manage Account / Clients Timing Modal State
  const [accountToManage, setAccountToManage] = useState(null);
  const [manageScale, setManageScale] = useState(10);
  const [manageMinWait, setManageMinWait] = useState(8);
  const [manageMaxWait, setManageMaxWait] = useState(15);
  const [manageSessionDuration, setManageSessionDuration] = useState(60);
  const [manageApplyAll, setManageApplyAll] = useState(false);
  const [manageSaving, setManageSaving] = useState(false);
  const [manageSuccessMsg, setManageSuccessMsg] = useState('');
  const [manageErrorMsg, setManageErrorMsg] = useState('');
  const [fleetPresetLoading, setFleetPresetLoading] = useState(false);

  const getCachedMetrics = useCallback(() => {
    const saved = localStorage.getItem('kickbacks_cached_metrics');
    return saved ? JSON.parse(saved) : {
      realTodayUsd: 0,
      realLifetimeUsd: 0,
      estimatedRevenue: 0,
      totalClientsCount: 0,
      runningBackends: 0,
      uniqueProfilesCount: 0,
      allClientsList: []
    };
  }, []);

  const [selectedLogInstance, setSelectedLogInstance] = useState(instances[0] || '');
  const [configJson, setConfigJson] = useState('[]');
  const [configSaving, setConfigSaving] = useState(false);

  const [revenueHistories, setRevenueHistories] = useState({});
  const [historyLoading, setHistoryLoading] = useState(false);

  // Rolling revenue samples for velocity calculation
  const revenueSamplesRef = useRef([]);
  const MAX_SAMPLES = 30; // Keep ~2.5 min of samples at 5s polling

  const logsEndRef = useRef(null);
  const initialAuthCheckedRef = useRef(!password);

  const verifyPassword = useCallback(async (pass) => {
    setAuthChecking(true);
    setAuthError('');
    const testUrl = instances[0] || 'http://localhost:3001';
    try {
      const res = await fetch(`${testUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      });
      if (res.ok) {
        localStorage.setItem('dashboard_password', pass);
        setPassword(pass);
        setIsAuthorized(true);
      } else {
        setAuthError('Invalid master password.');
      }
    } catch (err) {
      console.warn("Auth check failed:", err.message);
      // Fallback in case of CORS / offline
      localStorage.setItem('dashboard_password', pass);
      setPassword(pass);
      setIsAuthorized(true);
    } finally {
      setAuthChecking(false);
      setLoading(false);
    }
  }, [instances]);

  // Initial Auth Check
  useEffect(() => {
    if (initialAuthCheckedRef.current || !password) return;
    initialAuthCheckedRef.current = true;
    verifyPassword(password);
  }, [password, verifyPassword]);

  // Save instances list
  useEffect(() => {
    localStorage.setItem('dashboard_instances', JSON.stringify(instances));
  }, [instances]);

  // Status Polling Loop
  useEffect(() => {
    if (!isAuthorized) return;

    const fetchAllStatuses = async () => {
      const results = {};
      await Promise.all(
        instances.map(async (url) => {
          try {
            const res = await fetch(`${url}/api/status`, {
              headers: {
                'Authorization': `Bearer ${password}`,
                'Content-Type': 'application/json'
              }
            });
            if (res.ok) {
              const data = await res.json();
              results[url] = {
                online: true,
                running: data.running,
                instanceName: data.instanceName,
                profiles: data.profiles || [],
                clients: data.clients || [],
                totals: data.totals || {},
                logs: data.logs || [],
                configProfiles: data.configProfiles || []
              };
            } else {
              results[url] = { online: false, error: `HTTP ${res.status}` };
            }
          } catch (err) {
            results[url] = { online: false, error: err.message };
          }
        })
      );
      setStatuses(results);
      setLoading(false);
    };

    fetchAllStatuses();
    let interval = setInterval(fetchAllStatuses, 4500);

    const handleVisibilityChange = () => {
      clearInterval(interval);
      if (document.hidden) {
        interval = setInterval(fetchAllStatuses, 30000);
      } else {
        fetchAllStatuses();
        interval = setInterval(fetchAllStatuses, 4500);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthorized, instances, password, refreshTrigger]);

  // Save status metrics to localStorage when statuses change
  useEffect(() => {
    const onlineCount = Object.values(statuses).filter(s => s.online).length;
    if (onlineCount === 0) return;

    let runningBackends = Object.values(statuses).filter(s => s.online && s.running).length;
    let totalClientsCount = 0;
    let allClientsList = [];
    const uniqueProfiles = {};

    Object.keys(statuses).forEach(url => {
      const s = statuses[url];
      if (s && s.online) {
        const runningClients = s.clients || [];
        allClientsList = [
          ...allClientsList,
          ...runningClients.map(c => ({
            ...c,
            instanceUrl: url,
            instanceName: s.instanceName
          }))
        ];
        totalClientsCount += runningClients.filter(c => c.lastStatus !== 'Stopped' && c.lastStatus !== 'inactive').length;
        (s.profiles || []).forEach(p => {
          if (!uniqueProfiles[p.name] || (uniqueProfiles[p.name].currentLifetimeUsd || 0) < (p.currentLifetimeUsd || 0)) {
            uniqueProfiles[p.name] = p;
          }
        });
      }
    });

    const realTodayUsd = Object.values(uniqueProfiles).reduce((sum, p) => sum + (p.currentTodayUsd || 0), 0);
    const realLifetimeUsd = Object.values(uniqueProfiles).reduce((sum, p) => sum + (p.currentLifetimeUsd || 0), 0);
    const estimatedRevenue = allClientsList.reduce((sum, c) => sum + (parseFloat(c.revenue_usd) || 0), 0);

    const newMetrics = {
      realTodayUsd,
      realLifetimeUsd,
      estimatedRevenue,
      totalClientsCount,
      runningBackends,
      uniqueProfilesCount: Object.keys(uniqueProfiles).length,
      allClientsList
    };

    localStorage.setItem('kickbacks_cached_metrics', JSON.stringify(newMetrics));
  }, [statuses]);

  // Fetch histories when Analytics tab is selected
  useEffect(() => {
    if (!isAuthorized || activeTab !== 'analytics') return;

    const fetchRevenueHistories = async () => {
      setHistoryLoading(true);
      const histories = {};
      await Promise.all(
        instances.map(async (url) => {
          try {
            const res = await fetch(`${url}/api/revenue-history`, {
              headers: { 'Authorization': `Bearer ${password}` }
            });
            if (res.ok) {
              const data = await res.json();
              histories[url] = data;
            }
          } catch (err) {
            console.error(`Failed to fetch history for ${url}:`, err);
          }
        })
      );
      setRevenueHistories(histories);
      setHistoryLoading(false);
    };

    fetchRevenueHistories();
  }, [isAuthorized, activeTab, instances, password, refreshTrigger]);

  // Load config JSON into configurator
  useEffect(() => {
    if (activeTab !== 'config') return undefined;

    const onlineInstance = Object.keys(statuses).find(url => statuses[url]?.online);
    if (!onlineInstance || !statuses[onlineInstance]?.configProfiles) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setConfigJson(JSON.stringify(statuses[onlineInstance].configProfiles, null, 2));
    }, 0);

    return () => window.clearTimeout(timer);
  }, [activeTab, statuses]);

  // Auto-scroll log console
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [statuses, selectedLogInstance]);

  const handleLoginSubmit = (e) => {
    e.preventDefault();
    const inputPass = e.target.elements.authPassword.value;
    verifyPassword(inputPass);
  };

  const handleLogout = () => {
    localStorage.removeItem('dashboard_password');
    setPassword('');
    setIsAuthorized(false);
  };

  const handleAddInstance = (e) => {
    e.preventDefault();
    if (!newUrl) return;
    let formatted = newUrl.trim();
    if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
      formatted = 'https://' + formatted;
    }
    if (formatted.endsWith('/')) {
      formatted = formatted.slice(0, -1);
    }
    if (!instances.includes(formatted)) {
      setInstances([...instances, formatted]);
    }
    setNewUrl('');
  };

  const handleRemoveInstance = (url) => {
    if (window.confirm(`Are you sure you want to remove instance: ${url}?`)) {
      const nextInstances = instances.filter(u => u !== url);
      setInstances(nextInstances);
      if (selectedLogInstance === url) {
        setSelectedLogInstance(nextInstances[0] || '');
      }
    }
  };

  const startAllSimulators = async () => {
    await Promise.all(
      instances.map(async (url) => {
        try {
          await fetch(`${url}/api/start`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${password}` }
          });
        } catch (err) {
          console.error(`Start failed for ${url}:`, err);
        }
      })
    );
    setRefreshTrigger(prev => prev + 1);
  };

  const stopAllSimulators = async () => {
    await Promise.all(
      instances.map(async (url) => {
        try {
          await fetch(`${url}/api/stop`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${password}` }
          });
        } catch (err) {
          console.error(`Stop failed for ${url}:`, err);
        }
      })
    );
    setRefreshTrigger(prev => prev + 1);
  };

  const startSingleSimulator = async (url) => {
    try {
      await fetch(`${url}/api/start`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${password}` }
      });
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Failed to start simulator: ${err.message}`);
    }
  };

  const stopSingleSimulator = async (url) => {
    try {
      await fetch(`${url}/api/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${password}` }
      });
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Failed to stop simulator: ${err.message}`);
    }
  };

  const clearInstanceLogs = async (url) => {
    try {
      await fetch(`${url}/api/clear-logs`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${password}` }
      });
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Failed to clear logs: ${err.message}`);
    }
  };

  // Google OAuth Start Login Flow
  const handleStartGoogleLogin = async () => {
    setAuthStatus('starting');
    setAuthErrorMsg('');
    try {
      const activeUrl = instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
      const res = await fetch(`${activeUrl}/api/auth/start-login`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ scale: parseInt(googleScale, 10) || 10 })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start login session');
      }

      setAuthSession({ ...data, apiUrl: activeUrl });
      setAuthStatus('polling');
      
      // Attempt to open the Google login window
      window.open(data.loginUrl, '_blank');
    } catch (err) {
      setAuthStatus('error');
      setAuthErrorMsg(err.message);
    }
  };

  // Google OAuth Poll Effect
  useEffect(() => {
    if (authStatus !== 'polling' || !authSession?.sessionId) return;

    const apiUrl = authSession.apiUrl || (instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001');
    let isCancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/auth/poll-login/${authSession.sessionId}`, {
          headers: {
            'Authorization': `Bearer ${password}`
          }
        });
        const data = await res.json();
        if (isCancelled) return;

        if (res.ok && data.status === 'success') {
          setAuthStatus('success');
          setRefreshTrigger(prev => prev + 1);
        } else if (!res.ok || data.status === 'error') {
          setAuthStatus('error');
          setAuthErrorMsg(data.error || 'Login authorization failed.');
        }
      } catch (err) {
        // Network blip, keep polling
      }
    };

    poll();
    const interval = setInterval(poll, 1500);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [authStatus, authSession?.sessionId, authSession?.apiUrl, password]);

  // Manual Refresh Token Addition
  const handleManualAddAccount = async (e) => {
    e.preventDefault();
    setManualSaving(true);
    setManualErrorMsg('');
    setManualSuccessMsg('');
    try {
      const activeUrl = instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
      const res = await fetch(`${activeUrl}/api/auth/add-account`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: manualAccountName.trim(),
          refreshToken: manualRefreshToken.trim(),
          scale: parseInt(manualScale, 10) || 10,
          minPromptWait: parseInt(manualMinWait, 10) || 8,
          maxPromptWait: parseInt(manualMaxWait, 10) || 15,
          sessionDuration: parseInt(manualSessionDuration, 10) || 60
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add account');
      }

      setManualSuccessMsg(`Account '${data.account.name}' added successfully! Simulator fleet restarted.`);
      setManualRefreshToken('');
      setManualAccountName('');
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      setManualErrorMsg(err.message);
    } finally {
      setManualSaving(false);
    }
  };

  // Quick Scale Specific Account
  const handleQuickScaleAccount = async (acc, newScale) => {
    const scaleVal = Math.max(1, parseInt(newScale, 10));
    if (isNaN(scaleVal)) return;
    setScalingAccountName(acc.name);
    const targetUrl = acc.url || instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
    try {
      const res = await fetch(`${targetUrl}/api/auth/account/${encodeURIComponent(acc.name)}/scale`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ scale: scaleVal })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to scale account');
      }
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Error scaling account '${acc.name}': ${err.message}`);
    } finally {
      setScalingAccountName(null);
    }
  };

  // Quick Scale Entire Fleet
  const handleQuickScaleFleet = async (newScale) => {
    const scaleVal = Math.max(1, parseInt(newScale, 10));
    if (isNaN(scaleVal)) return;
    setFleetScaleSaving(true);
    const targetUrl = instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
    try {
      const res = await fetch(`${targetUrl}/api/auth/fleet-scale`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ scale: scaleVal })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to scale fleet');
      }
      setFleetScaleInput(scaleVal);
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Error scaling fleet: ${err.message}`);
    } finally {
      setFleetScaleSaving(false);
    }
  };

  // Create Simulated Account
  const handleCreateSimulatedAccount = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSimulatedSaving(true);
    setSimulatedErrorMsg('');
    const targetUrl = instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
    try {
      const res = await fetch(`${targetUrl}/api/auth/add-account`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: simulatedName.trim() || `sim_bot_${displayedAccounts.length + 1}`,
          isSimulated: true,
          scale: Math.max(1, parseInt(simulatedScale, 10) || 10),
          minPromptWait: 6,
          maxPromptWait: 12,
          sessionDuration: 60
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create simulated account');
      }
      setSimulatedName('');
      setRefreshTrigger(prev => prev + 1);
      setShowConnectModal(false);
    } catch (err) {
      setSimulatedErrorMsg(err.message);
    } finally {
      setSimulatedSaving(false);
    }
  };

  // Open Manage Account Modal
  const handleOpenManageAccount = (acc) => {
    setAccountToManage(acc);
    setManageScale(acc.scale || acc.config?.scale || acc.profile?.scale || 10);
    setManageMinWait(acc.minPromptWait || acc.config?.minPromptWait || acc.profile?.minPromptWait || 8);
    setManageMaxWait(acc.maxPromptWait || acc.config?.maxPromptWait || acc.profile?.maxPromptWait || 15);
    setManageSessionDuration(acc.sessionDuration || acc.config?.sessionDuration || acc.profile?.sessionDuration || 60);
    setManageApplyAll(false);
    setManageSuccessMsg('');
    setManageErrorMsg('');
  };

  // Save Account Settings (Single or Fleet-wide)
  const handleSaveAccountSettings = async (e) => {
    e.preventDefault();
    if (!accountToManage) return;
    setManageSaving(true);
    setManageErrorMsg('');
    setManageSuccessMsg('');

    const targetUrl = accountToManage.url || instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
    const payload = {
      scale: Math.max(1, parseInt(manageScale, 10) || 10),
      minPromptWait: Math.max(1, parseInt(manageMinWait, 10) || 8),
      maxPromptWait: Math.max(1, parseInt(manageMaxWait, 10) || 15),
      sessionDuration: Math.max(10, parseInt(manageSessionDuration, 10) || 60)
    };

    if (payload.maxPromptWait < payload.minPromptWait) {
      payload.maxPromptWait = payload.minPromptWait;
    }

    try {
      if (manageApplyAll) {
        const res = await fetch(`${targetUrl}/api/auth/fleet-settings`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${password}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update fleet settings');
        setManageSuccessMsg(`Updated all fleet accounts! Running with ${payload.scale} clients per account.`);
      } else {
        const res = await fetch(`${targetUrl}/api/auth/account/${encodeURIComponent(accountToManage.name)}/settings`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${password}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update account settings');
        setManageSuccessMsg(`Settings saved for '${accountToManage.name}'! Running with ${payload.scale} clients.`);
      }
      setRefreshTrigger(prev => prev + 1);
      setTimeout(() => {
        setAccountToManage(null);
      }, 1200);
    } catch (err) {
      setManageErrorMsg(err.message);
    } finally {
      setManageSaving(false);
    }
  };

  // Apply Quick Fleet-Wide Preset
  const handleApplyFleetPreset = async (preset) => {
    setFleetPresetLoading(true);
    const targetUrl = instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
    try {
      const res = await fetch(`${targetUrl}/api/auth/fleet-settings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(preset)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to apply fleet preset');
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Error applying fleet preset: ${err.message}`);
    } finally {
      setFleetPresetLoading(false);
    }
  };

  // Delete Account
  const handleDeleteAccount = async (accountName) => {
    if (!window.confirm(`Are you sure you want to remove account '${accountName}'?`)) return;
    try {
      const activeUrl = instances.find(u => statuses[u]?.online) || instances[0] || 'http://localhost:3001';
      const res = await fetch(`${activeUrl}/api/auth/account/${encodeURIComponent(accountName)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${password}`
        }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete account');
      }
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Error deleting account: ${err.message}`);
    }
  };

  const saveConfiguration = async (e) => {
    e.preventDefault();
    setConfigSaving(true);
    try {
      const parsed = JSON.parse(configJson);
      const onlineUrls = instances.filter(url => statuses[url]?.online);
      if (onlineUrls.length === 0) {
        throw new Error("No backend instances are online to save config.");
      }

      await Promise.all(
        onlineUrls.map(async (url) => {
          const res = await fetch(`${url}/api/config`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${password}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(parsed)
          });
          if (!res.ok) {
            throw new Error(`Failed to save config on ${url}`);
          }
        })
      );

      alert("Configuration updated successfully. Simulators are restarting.");
      setRefreshTrigger(prev => prev + 1);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setConfigSaving(false);
    }
  };

  // Log level message styling
  const getLogClass = (message) => {
    if (message.includes('SYSTEM:')) return 'console-msg system';
    if (message.includes('ERROR:')) return 'console-msg error';
    if (message.includes('Auth:')) return 'console-msg auth';
    if (message.includes('Tick:')) return 'console-msg success';
    if (message.includes('Billing') || message.includes('Billed')) return 'console-msg billing';
    return 'console-msg';
  };

  // Aggregate Metrics Calculations
  const onlineCount = Object.values(statuses).filter(s => s.online).length;

  let runningBackends = 0;
  let totalClientsCount = 0;
  let allClientsList = [];
  const uniqueProfiles = {};
  let uniqueProfilesCount = 0;

  // Real earnings from Kickbacks /v1/earnings API
  let realTodayUsd = 0;
  let realLifetimeUsd = 0;
  let sessionEarnedToday = 0;

  // Local estimated revenue (billing_count * $0.0001)
  let estimatedRevenue = 0;
  let totalBillingCount = 0;

  if (onlineCount > 0) {
    runningBackends = Object.values(statuses).filter(s => s.online && s.running).length;
    Object.keys(statuses).forEach(url => {
      const s = statuses[url];
      if (s && s.online) {
        const runningClients = s.clients || [];
        allClientsList = [
          ...allClientsList,
          ...runningClients.map(c => ({
            ...c,
            instanceUrl: url,
            instanceName: s.instanceName
          }))
        ];

        totalClientsCount += runningClients.filter(c => c.lastStatus !== 'Stopped' && c.lastStatus !== 'inactive').length;

        (s.profiles || []).forEach(p => {
          if (!uniqueProfiles[p.name] || (uniqueProfiles[p.name].currentLifetimeUsd || 0) < (p.currentLifetimeUsd || 0)) {
            uniqueProfiles[p.name] = p;
          }
        });

        // Aggregate real earnings from each backend
        if (s.realEarnings) {
          realTodayUsd += (s.realEarnings.todayUsd || 0);
          realLifetimeUsd += (s.realEarnings.lifetimeUsd || 0);
          sessionEarnedToday += (s.realEarnings.sessionEarnedToday || 0);
        }
        if (s.estimatedRevenue) {
          estimatedRevenue += (s.estimatedRevenue.total || 0);
          totalBillingCount += (s.estimatedRevenue.totalBillingCount || 0);
        }
      }
    });
    // Deduplicate real earnings from profiles (same account seen by multiple backends)
    realTodayUsd = Object.values(uniqueProfiles).reduce((sum, p) => sum + (p.currentTodayUsd || 0), 0);
    realLifetimeUsd = Object.values(uniqueProfiles).reduce((sum, p) => sum + (p.currentLifetimeUsd || 0), 0);
    sessionEarnedToday = Object.values(uniqueProfiles).reduce((sum, p) => sum + (p.earnedTodayRun || 0), 0);
    uniqueProfilesCount = Object.keys(uniqueProfiles).length;

    // Estimated revenue from client billing counts
    const totalClientRevenueSum = allClientsList.reduce((sum, c) => sum + (parseFloat(c.revenue_usd) || 0), 0);
    if (totalClientRevenueSum > estimatedRevenue) {
      estimatedRevenue = totalClientRevenueSum;
    }

    // Track revenue samples for velocity calculation (use estimated since real may be delayed)
    const now = Date.now();
    const samples = revenueSamplesRef.current;
    if (samples.length === 0 || now - samples[samples.length - 1].t >= 4000) {
      samples.push({ t: now, v: estimatedRevenue });
      if (samples.length > MAX_SAMPLES) samples.shift();
    }

  } else {
    // When offline, fallback to the overall global cached metrics
    const cached = getCachedMetrics();
    runningBackends = cached.runningBackends;
    estimatedRevenue = cached.estimatedRevenue || cached.totalTodayRun || 0;
    totalClientsCount = cached.totalClientsCount;
    realTodayUsd = cached.realTodayUsd || 0;
    realLifetimeUsd = cached.realLifetimeUsd || 0;
    uniqueProfilesCount = cached.uniqueProfilesCount;
    allClientsList = cached.allClientsList || [];
  }

  // === COMPUTED ANALYTICS (all derived, zero hardcoded) ===

  // Revenue Velocity
  const samples = revenueSamplesRef.current;
  let revenuePerMinute = 0;
  let revenuePerHour = 0;
  let projectedDaily = 0;

  if (samples.length >= 2) {
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const dtMinutes = (newest.t - oldest.t) / 60000;
    if (dtMinutes > 0) {
      const delta = newest.v - oldest.v;
      revenuePerMinute = Math.max(0, delta / dtMinutes);
      revenuePerHour = revenuePerMinute * 60;
      projectedDaily = revenuePerHour * 24;
    }
  }

  // Fleet Efficiency
  const activeClients = allClientsList.filter(c => c.lastStatus !== 'Stopped' && c.lastStatus !== 'inactive').length;
  const totalTicks = allClientsList.reduce((sum, c) => sum + (c.ticks || 0), 0);
  const totalBills = allClientsList.reduce((sum, c) => sum + (c.billing_count || 0), 0);
  const billingSuccessRate = totalTicks > 0 ? ((totalBills / totalTicks) * 100) : 0;
  const revenuePerClient = activeClients > 0 ? (estimatedRevenue / activeClients) : 0;
  const revenuePerBackend = runningBackends > 0 ? (estimatedRevenue / runningBackends) : 0;
  const errorClients = allClientsList.filter(c => (c.lastStatus || '').includes('HTTP Error') || (c.lastStatus || '').includes('Billing Error')).length;
  const errorRate = allClientsList.length > 0 ? ((errorClients / allClientsList.length) * 100) : 0;
  const fleetUtilization = allClientsList.length > 0 ? ((activeClients / allClientsList.length) * 100) : 0;
  const avgTicksPerClient = activeClients > 0 ? (totalTicks / activeClients) : 0;
  const avgBillsPerClient = activeClients > 0 ? (totalBills / activeClients) : 0;

  // Fleet Analytics Computations
  const totalFleetTicks = allClientsList.reduce((acc, c) => acc + (c.ticks || 0), 0);
  const totalFleetRevenue = allClientsList.reduce((acc, c) => acc + (parseFloat(c.revenue_usd) || 0), 0);
  const fleetRpm = totalFleetTicks > 0 ? ((totalFleetRevenue / totalFleetTicks) * 1000).toFixed(2) : '0.00';
  const fleetConversionRate = totalFleetTicks > 0 ? ((totalBills / totalFleetTicks) * 100).toFixed(1) : '0.0';

  // Ad Sponsor Campaign Breakdown
  const adPerformanceMap = {};
  allClientsList.forEach((c) => {
    const title = c.adTitle || 'Rotating / Pending';
    if (!adPerformanceMap[title]) {
      adPerformanceMap[title] = {
        title,
        clientsCount: 0,
        ticks: 0,
        bills: 0,
        revenue: 0
      };
    }
    adPerformanceMap[title].clientsCount += 1;
    adPerformanceMap[title].ticks += (c.ticks || 0);
    adPerformanceMap[title].bills += (c.billing_count || 0);
    adPerformanceMap[title].revenue += (parseFloat(c.revenue_usd) || 0);
  });
  const adPerformanceList = Object.values(adPerformanceMap).sort((a, b) => b.revenue - a.revenue);

  const activeTitle = TAB_TITLES[activeTab] || 'Dashboard';

  // MUI X Charts data
  const buildRevenueChart = () => {
    const allTimestamps = new Set();

    instances.forEach((url) => {
      const history = revenueHistories[url] || [];
      history.forEach(pt => {
        allTimestamps.add(new Date(pt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      });
    });

    let labels = Array.from(allTimestamps).sort();
    if (labels.length === 0) {
      const now = Date.now();
      labels = [
        new Date(now - 120000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        new Date(now - 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      ];
    } else if (labels.length === 1) {
      labels = [
        new Date(Date.now() - 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        labels[0]
      ];
    }

    const series = instances.map((url, idx) => {
      const history = revenueHistories[url] || [];
      const s = statuses[url];
      const accountName = s?.profiles?.[0]?.name || s?.instanceName?.split(' · ')[1] || `Account #${idx + 1}`;
      const dataMap = {};
      history.forEach(pt => {
        dataMap[new Date(pt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })] = parseFloat(pt.today_usd || 0);
      });

      // Total revenue for this instance from its active clients
      const clientRev = (s?.clients || []).reduce((sum, c) => sum + (parseFloat(c.revenue_usd) || 0), 0);

      const dataPoints = labels.map((lbl, lIdx) => {
        if (dataMap[lbl] !== undefined && dataMap[lbl] > 0) return dataMap[lbl];
        if (lIdx === labels.length - 1) return clientRev;
        if (lIdx === 0) return 0;
        return (clientRev * (lIdx / (labels.length - 1)));
      });

      return {
        id: url,
        label: `#${idx + 1} ${accountName}`,
        data: dataPoints,
        curve: 'linear',
        connectNulls: true,
        showMark: ({ index }) => index === dataPoints.length - 1,
        valueFormatter: (value) => value == null ? '$0.0000' : `$${Number(value).toFixed(4)}`
      };
    });

    return { labels, series };
  };
  const revenueChart = buildRevenueChart();

  if (loading) {
    return (
      <div className="auth-overlay">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div className="logo-leaf" style={{ margin: '0 auto 18px auto', width: 44, height: 44 }}>
            <Cpu size={22} />
          </div>
          <div className="auth-header">
            <h1>Kickbacks Atlas</h1>
            <p>Connecting to {instances.length > 1 ? `${instances.length} dedicated account backends` : 'dedicated backend'}...</p>
          </div>
          <div className="loading-ring" style={{ margin: '16px auto 0 auto' }} aria-label="Loading" />
        </div>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="auth-overlay">
        <form className="auth-card" onSubmit={handleLoginSubmit}>
          <div className="logo-leaf" style={{ margin: '0 auto 18px auto', width: 44, height: 44 }}>
            <ShieldAlert size={22} />
          </div>
          <div className="auth-header" style={{ textAlign: 'center' }}>
            <h1>Kickbacks Atlas</h1>
            <p>Sign in to manage the 5-account dedicated fleet</p>
          </div>
          <div className="form-group">
            <label htmlFor="authPassword">Master Password</label>
            <input
              id="authPassword"
              name="authPassword"
              type="password"
              className="form-input"
              placeholder="Master password"
              required
            />
          </div>
          <button type="submit" className="btn-primary-pill" style={{ width: '100%', justifyContent: 'center' }} disabled={authChecking}>
            {authChecking ? 'Verifying Credentials...' : 'Access Atlas Fleet'}
          </button>
          <p style={{ fontSize: '11px', color: 'var(--steel)', marginTop: '12px', textAlign: 'center' }}>
            Local default password: <code style={{ color: 'var(--accent-purple)' }}>Ankitsin</code>
          </p>
          {authError && <div className="auth-error">{authError}</div>}
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Global Navigation (Clean White Sticky Header) */}
      <nav className="global-nav">
        <div className="global-nav-content">
          <div className="global-nav-left">
            <button className="global-nav-logo" onClick={() => setActiveTab('dashboard')}>
              <div className="logo-leaf">
                <Cpu size={16} />
              </div>
              <div className="logo-text-group">
                <span className="logo-text">Kickbacks</span>
                <span className="logo-badge">Fleet</span>
              </div>
            </button>

            <div className="nav-pill-tabs" role="tablist" aria-label="Primary navigation">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`pill-tab-item ${activeTab === id ? 'active' : ''}`}
                  onClick={() => setActiveTab(id)}
                  role="tab"
                  aria-selected={activeTab === id}
                >
                  <Icon size={14} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="global-nav-right">
            <div className="badge-soft-pill">
              <span className="status-pulse-dot"></span>
              <span>{onlineCount}/{instances.length} Online</span>
            </div>
            <div className="badge-soft-pill neutral">
              <Activity size={13} />
              <span>{runningBackends} Running</span>
            </div>

            {activeTab === 'dashboard' && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary-pill" onClick={startAllSimulators}>
                  <Play size={13} fill="currentColor" />
                  Start All
                </button>
                <button className="btn-secondary-pill danger" onClick={stopAllSimulators}>
                  <Square size={12} fill="currentColor" />
                  Stop All
                </button>
              </div>
            )}

            <button
              className="btn-primary-pill"
              style={{ padding: '6px 14px', fontSize: '12px' }}
              onClick={() => {
                setAuthStatus('idle');
                setAuthErrorMsg('');
                setManualErrorMsg('');
                setManualSuccessMsg('');
                setShowConnectModal(true);
              }}
              title="Add or login Kickbacks account"
            >
              <UserPlus size={13} />
              <span>+ Connect Account</span>
            </button>

            <button
              className="btn-icon-pill"
              onClick={() => setRefreshTrigger(p => p + 1)}
              title="Refresh stats"
              aria-label="Refresh stats"
            >
              <RefreshCw size={14} />
            </button>

            <button
              className="btn-icon-pill"
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </nav>

      {/* Main App Container */}
      <div className="app-container" style={{ paddingTop: '24px' }}>

        {/* TAB 1: DASHBOARD VIEW */}
        {activeTab === 'dashboard' && (
          <div>
            {/* Overview Metric Strip */}
            <div className="section-header" style={{ marginBottom: '14px' }}>
              <div>
                <p className="section-kicker">Fleet Intelligence</p>
                <h2 className="section-title">Overview</h2>
              </div>
              <span className="panel-count">{allClientsList.length} Active Clients</span>
            </div>

            <section className="metric-strip" aria-label="Fleet summary" style={{ marginBottom: '28px' }}>
              <div className="metric-tile">
                <div className="metric-icon-wrap green">
                  <DollarSign size={20} />
                </div>
                <div>
                  <p className="metric-label">Kickbacks Earnings (Today)</p>
                  <p className="metric-value">${realTodayUsd.toFixed(6)}</p>
                </div>
              </div>

              <div className="metric-tile">
                <div className="metric-icon-wrap blue">
                  <CircleDollarSign size={20} />
                </div>
                <div>
                  <p className="metric-label">Lifetime Balance</p>
                  <p className="metric-value">${realLifetimeUsd.toFixed(6)}</p>
                </div>
              </div>

              <div className="metric-tile">
                <div className="metric-icon-wrap purple">
                  <Target size={20} />
                </div>
                <div>
                  <p className="metric-label">Billing Events (est.)</p>
                  <p className="metric-value">{totalBills} billed</p>
                </div>
              </div>

              <div className="metric-tile">
                <div className="metric-icon-wrap orange">
                  <Activity size={20} />
                </div>
                <div>
                  <p className="metric-label">Active Clients</p>
                  <p className="metric-value">{activeClients} / {allClientsList.length}</p>
                </div>
              </div>
            </section>

            {/* Simulation & Bot Fleet Concurrency Controller */}
            <div className="sim-control-panel">
              <div className="sim-control-header">
                <div>
                  <h3 className="sim-control-title">
                    <Cpu size={18} style={{ color: 'var(--accent-purple)' }} />
                    Simulation Bot Scaler &amp; Fleet Concurrency
                  </h3>
                  <p className="sim-control-desc">
                    Adjust concurrent bot load per account or across the entire fleet in real-time.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span className="chip purple" style={{ fontSize: '12px', padding: '4px 10px', fontWeight: 700 }}>
                    {displayedAccounts.length} Account{displayedAccounts.length === 1 ? '' : 's'}
                  </span>
                  <span className="chip cyan" style={{ fontSize: '12px', padding: '4px 10px', fontWeight: 700 }}>
                    {displayedAccounts.reduce((sum, a) => sum + (a.scale || 10), 0)} Total Bots
                  </span>
                </div>
              </div>

              {/* Fleet-Wide Concurrency Control Row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px', paddingTop: '10px', borderTop: '1px solid rgba(124, 58, 237, 0.12)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
                    Scale All Accounts:
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <button
                      type="button"
                      className="btn-stepper"
                      disabled={fleetScaleSaving || fleetScaleInput <= 1}
                      onClick={() => setFleetScaleInput(prev => Math.max(1, prev - 1))}
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={fleetScaleInput}
                      onChange={e => setFleetScaleInput(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{
                        width: '60px',
                        textAlign: 'center',
                        fontWeight: 700,
                        fontSize: '13px',
                        padding: '4px',
                        border: '1px solid var(--hairline)',
                        borderRadius: 'var(--rounded-sm)',
                        color: 'var(--accent-purple)'
                      }}
                    />
                    <button
                      type="button"
                      className="btn-stepper"
                      disabled={fleetScaleSaving || fleetScaleInput >= 100}
                      onClick={() => setFleetScaleInput(prev => Math.min(100, prev + 1))}
                    >
                      +
                    </button>
                  </div>

                  <button
                    type="button"
                    className="btn-primary-pill"
                    style={{ padding: '6px 14px', fontSize: '12px' }}
                    disabled={fleetScaleSaving || displayedAccounts.length === 0}
                    onClick={() => handleQuickScaleFleet(fleetScaleInput)}
                  >
                    {fleetScaleSaving ? <RefreshCw size={12} className="spinning" /> : <SlidersHorizontal size={12} />}
                    <span>{fleetScaleSaving ? 'Applying...' : 'Apply to All'}</span>
                  </button>

                  <div style={{ display: 'flex', gap: '4px', marginLeft: '6px' }}>
                    {[5, 10, 25, 50].map(cnt => (
                      <button
                        key={cnt}
                        type="button"
                        className="preset-chip-btn"
                        style={{ fontSize: '11px', padding: '4px 10px' }}
                        disabled={fleetScaleSaving || displayedAccounts.length === 0}
                        onClick={() => {
                          setFleetScaleInput(cnt);
                          handleQuickScaleFleet(cnt);
                        }}
                      >
                        {cnt} bots
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn-outline-pill"
                    style={{ padding: '6px 14px', fontSize: '12px', color: 'var(--accent-purple)', borderColor: 'rgba(124, 58, 237, 0.35)' }}
                    onClick={() => {
                      setAuthStatus('idle');
                      setAuthErrorMsg('');
                      setManualErrorMsg('');
                      setManualSuccessMsg('');
                      setShowConnectModal(true);
                    }}
                  >
                    <UserPlus size={13} />
                    <span>+ Add Account</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Accounts & Divided Clients Telemetry */}
            <div className="section-header" style={{ marginBottom: '14px' }}>
              <div>
                <p className="section-kicker">Accounts &amp; Virtual Clients</p>
                <h2 className="section-title">Fleet Accounts ({displayedAccounts.length})</h2>
              </div>
              <span className="panel-count">{allClientsList.length} Clients Total</span>
            </div>

            {displayedAccounts.length === 0 ? (
              <div className="onboarding-hero">
                <div className="onboarding-icon-ring">
                  <Cpu size={32} />
                </div>
                <h3 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 8px 0', color: 'var(--ink)' }}>
                  No Accounts Active in Simulation
                </h3>
                <p style={{ fontSize: '14px', color: 'var(--steel)', maxWidth: '540px', margin: '0 auto 24px auto', lineHeight: 1.5 }}>
                  Add multiple Kickbacks accounts to simulate concurrent virtual bots generating real or simulated ad revenue and tracking live telemetry.
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-primary-pill"
                    onClick={() => {
                      setConnectTab('google');
                      setShowConnectModal(true);
                    }}
                  >
                    <Globe size={14} />
                    <span>Sign in with Google</span>
                  </button>
                  <button
                    type="button"
                    className="btn-outline-pill"
                    onClick={() => {
                      setConnectTab('token');
                      setShowConnectModal(true);
                    }}
                  >
                    <Key size={14} />
                    <span>Paste Refresh Token</span>
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    style={{ padding: '8px 16px', fontSize: '13px', background: 'rgba(124, 58, 237, 0.08)', color: 'var(--accent-purple)', borderColor: 'var(--accent-purple)' }}
                    onClick={() => handleCreateSimulatedAccount(10)}
                  >
                    <Sparkles size={14} />
                    <span>⚡ Add Test Simulated Bot (10 Bots)</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Account Selector Filter Bar */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' }}>
                  <button
                    className={`filter-tab-pill ${selectedAccount === 'all' ? 'active' : ''}`}
                    onClick={() => setSelectedAccount('all')}
                  >
                    All Accounts ({allClientsList.length})
                  </button>
                  {displayedAccounts.map((acc, idx) => {
                    const count = acc.clients?.length || 0;
                    return (
                      <button
                        key={acc.id}
                        className={`filter-tab-pill ${selectedAccount === String(idx) ? 'active' : ''}`}
                        onClick={() => setSelectedAccount(String(idx))}
                      >
                        #{idx + 1} {acc.name} ({count})
                      </button>
                    );
                  })}
                  <button
                    className="filter-tab-pill"
                    style={{ color: 'var(--accent-purple)', borderColor: 'rgba(124, 58, 237, 0.3)', background: 'rgba(124, 58, 237, 0.05)', fontWeight: 600 }}
                    onClick={() => {
                      setAuthStatus('idle');
                      setAuthErrorMsg('');
                      setManualErrorMsg('');
                      setManualSuccessMsg('');
                      setShowConnectModal(true);
                    }}
                  >
                    <UserPlus size={12} />
                    <span>+ Connect Account</span>
                  </button>
                </div>

                {/* Divided Account Panels with their respective clients */}
                <div className="account-sections-list">
                  {displayedAccounts.map((acc, idx) => {
                    if (selectedAccount !== 'all' && selectedAccount !== String(idx)) {
                      return null;
                    }
                    const { url, name: accountName, profile, clients, isOnline, isRunning, isSimulated } = acc;
                    const activeClientsCount = clients.filter(c => c.lastStatus !== 'Stopped' && c.lastStatus !== 'inactive').length;
                    const acctClientRev = clients.reduce((sum, c) => sum + (parseFloat(c.revenue_usd) || 0), 0);
                    const todayUsd = (profile?.currentTodayUsd !== undefined && profile.currentTodayUsd > 0) ? profile.currentTodayUsd : acctClientRev;
                    const lifetimeUsd = (profile?.currentLifetimeUsd !== undefined && profile.currentLifetimeUsd > 0) ? (profile.currentLifetimeUsd + acctClientRev) : acctClientRev;

                    return (
                      <div key={acc.id} className="panel" style={{ marginBottom: '22px', padding: 0, overflow: 'hidden' }}>
                        {/* Dedicated Account Header Bar */}
                        <div style={{
                          padding: '16px 20px',
                          backgroundColor: 'var(--canvas)',
                          borderBottom: '1px solid var(--hairline)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: '12px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span className="chip purple" style={{ fontSize: '11px', fontWeight: 600, padding: '3px 8px' }}>
                              Account #{idx + 1}
                            </span>
                            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ink)' }}>{accountName}</span>
                            {isSimulated ? (
                              <span className="chip cyan" style={{ fontSize: '10px', padding: '2px 8px' }}>
                                Simulated Bot
                              </span>
                            ) : (
                              <span className="chip purple" style={{ fontSize: '10px', padding: '2px 8px' }}>
                                Kickbacks Real
                              </span>
                            )}
                            <span className={`chip ${isOnline ? (isRunning ? 'green' : 'neutral') : 'neutral'}`} style={{ fontSize: '10px', padding: '2px 8px' }}>
                              {isOnline ? (isRunning ? 'Running' : 'Idle') : 'Offline'}
                            </span>
                            <span className="chip purple" style={{ fontSize: '10px', padding: '2px 8px', fontWeight: 700 }}>
                              {acc.scale || 10} Bots
                            </span>
                            <span className="chip cyan" style={{ fontSize: '10px', padding: '2px 8px' }}>
                              <Timer size={10} /> {acc.minPromptWait || 8}–{acc.maxPromptWait || 15}s wait
                            </span>
                            <span className="chip neutral" style={{ fontSize: '10px', padding: '2px 8px' }}>
                              {acc.sessionDuration || 60}s session
                            </span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
                            <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
                              <span style={{ color: 'var(--steel)' }}>Active Bots: <strong style={{ color: 'var(--ink)' }}>{activeClientsCount}/{acc.scale || clients.length || 10}</strong></span>
                              <span style={{ color: 'var(--steel)' }}>Earned: <strong style={{ color: 'var(--brand-green-dark)' }}>${acctClientRev.toFixed(6)}</strong></span>
                              <span style={{ color: 'var(--steel)' }}>Today: <strong style={{ color: 'var(--ink)' }}>${todayUsd.toFixed(4)}</strong></span>
                              <span style={{ color: 'var(--steel)' }}>Lifetime: <strong style={{ color: 'var(--ink)', fontFamily: 'var(--font-code)' }}>${lifetimeUsd.toFixed(2)}</strong></span>
                            </div>

                            <div style={{ display: 'flex', gap: '8px' }}>
                              {isOnline && !isRunning && (
                                <button className="btn-card-action start" onClick={() => startSingleSimulator(url)} style={{ padding: '4px 12px', fontSize: '11px' }}>
                                  <Play size={10} fill="currentColor" /> Start Bots
                                </button>
                              )}
                              {isOnline && isRunning && (
                                <button className="btn-card-action stop" onClick={() => stopSingleSimulator(url)} style={{ padding: '4px 12px', fontSize: '11px' }}>
                                  <Square size={9} fill="currentColor" /> Stop Bots
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-card-action"
                                title={`Configure clients & timings for ${accountName}`}
                                onClick={() => handleOpenManageAccount(acc)}
                                style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', borderColor: 'rgba(124, 58, 237, 0.35)', color: 'var(--accent-purple)' }}
                              >
                                <SlidersHorizontal size={10} /> Timing
                              </button>
                              <button
                                className="btn-card-action stop"
                                title={`Remove account ${accountName}`}
                                onClick={() => handleDeleteAccount(accountName)}
                                style={{ padding: '4px 10px', fontSize: '11px', color: 'var(--accent-red)' }}
                              >
                                <Trash2 size={10} /> Remove
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Inline Real-Time Bot Scaler Bar */}
                        <div style={{
                          padding: '10px 20px',
                          backgroundColor: 'rgba(0, 30, 43, 0.02)',
                          borderBottom: '1px solid var(--hairline)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: '12px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <Cpu size={14} style={{ color: 'var(--accent-purple)' }} />
                              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink)' }}>Adjust Bots:</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <button
                                type="button"
                                className="btn-stepper"
                                title="Decrease 1 bot"
                                disabled={scalingAccountName === accountName || (acc.scale || 10) <= 1}
                                onClick={() => handleQuickScaleAccount(acc, Math.max(1, (acc.scale || 10) - 1))}
                              >
                                -
                              </button>
                              <span style={{ minWidth: '55px', textAlign: 'center', fontWeight: 700, fontSize: '13px', color: 'var(--accent-purple)' }}>
                                {acc.scale || 10} bots
                              </span>
                              <button
                                type="button"
                                className="btn-stepper"
                                title="Increase 1 bot"
                                disabled={scalingAccountName === accountName || (acc.scale || 10) >= 100}
                                onClick={() => handleQuickScaleAccount(acc, (acc.scale || 10) + 1)}
                              >
                                +
                              </button>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span style={{ fontSize: '11px', color: 'var(--steel)' }}>Presets:</span>
                              {[5, 10, 25, 50].map(cnt => (
                                <button
                                  key={cnt}
                                  type="button"
                                  className={`chip-preset-small ${(acc.scale || 10) === cnt ? 'active' : ''}`}
                                  disabled={scalingAccountName === accountName}
                                  onClick={() => handleQuickScaleAccount(acc, cnt)}
                                >
                                  {cnt}
                                </button>
                              ))}
                            </div>
                          </div>

                          {scalingAccountName === accountName ? (
                            <span style={{ fontSize: '11px', color: 'var(--accent-purple)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <RefreshCw size={11} className="spinning" /> Applying new bot scale...
                            </span>
                          ) : (
                            <span style={{ fontSize: '11px', color: 'var(--steel)' }}>
                              {clients.length} / {acc.scale || 10} virtual clients in active loop
                            </span>
                          )}
                        </div>

                    {/* Table of Clients Divided to THIS Account */}
                    {clients.length === 0 ? (
                      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--steel)', fontSize: '13px' }}>
                        No clients initialized for this account yet. Click Start Account to begin.
                      </div>
                    ) : (
                      <div className="table-shell" style={{ border: 'none', borderRadius: 0 }}>
                        <table className="client-table">
                          <thead>
                            <tr>
                              <th>Client</th>
                              <th>Ad Render</th>
                              <th>Ticks</th>
                              <th>Bills</th>
                              <th>Revenue</th>
                              <th>Status</th>
                              <th>Last Tick</th>
                            </tr>
                          </thead>
                          <tbody>
                            {clients.map((client, cIdx) => {
                              const isBilled = client.lastStatus?.includes('Billed (Success)');
                              const isUnbilled = client.lastStatus?.includes('Unbilled');
                              const isSuccess = client.lastStatus?.includes('Success');
                              const isViewing = client.lastStatus?.includes('Viewing');
                              const isRotating = client.lastStatus?.includes('Next prompt') || client.lastStatus?.includes('Rotating') || client.lastStatus?.includes('cooldown');
                              const isError = client.lastStatus?.includes('Error');
                              const isStopped = client.lastStatus?.includes('Stopped');

                              let chipClass = 'neutral';
                              if (isBilled) chipClass = 'blue';
                              else if (isUnbilled) chipClass = 'neutral';
                              else if (isSuccess || isViewing) chipClass = 'green';
                              else if (isRotating) chipClass = 'purple';
                              else if (isError) chipClass = 'red';
                              else if (isStopped) chipClass = 'neutral';

                              return (
                                <tr key={cIdx}>
                                  <td>
                                    <span className="cell-code" style={{ fontWeight: 600 }}>{client.name}</span>
                                  </td>
                                  <td>{client.adTitle || <span className="muted-text">None</span>}</td>
                                  <td className="cell-number">{client.ticks || 0}</td>
                                  <td className="cell-number">{client.billing_count || 0}</td>
                                  <td className="cell-money">
                                    ${parseFloat(client.revenue_usd || 0).toFixed(6)}
                                  </td>
                                  <td>
                                    <span className={`chip ${chipClass}`}>
                                      {client.lastStatus || 'Initial'}
                                    </span>
                                  </td>
                                  <td className="muted-text">{client.lastTickTime || 'Never'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    )}

        {/* TAB 2: ANALYTICS VIEW */}
        {activeTab === 'analytics' && (
          <div>
            <div className="section-header" style={{ marginBottom: '14px' }}>
              <div>
                <p className="section-kicker">Fleet Intelligence &amp; Telemetry</p>
                <h2 className="section-title">Fleet Analytics</h2>
              </div>
              <span className="panel-count">{instances.length} Backend{instances.length === 1 ? '' : 's'} · {allClientsList.length} Clients</span>
            </div>

            {/* Analytics Metric Strip */}
            <section className="metric-strip" aria-label="Analytics summary" style={{ marginBottom: '24px' }}>
              <div className="metric-tile">
                <div className="metric-icon-wrap green">
                  <DollarSign size={20} />
                </div>
                <div>
                  <p className="metric-label">Verified Today Earnings</p>
                  <p className="metric-value">${realTodayUsd.toFixed(6)}</p>
                </div>
              </div>

              <div className="metric-tile">
                <div className="metric-icon-wrap blue">
                  <CircleDollarSign size={20} />
                </div>
                <div>
                  <p className="metric-label">Total Lifetime Balance</p>
                  <p className="metric-value">${realLifetimeUsd.toFixed(6)}</p>
                </div>
              </div>

              <div className="metric-tile">
                <div className="metric-icon-wrap purple">
                  <Activity size={20} />
                </div>
                <div>
                  <p className="metric-label">Fleet Impressions (Ticks)</p>
                  <p className="metric-value">{totalFleetTicks}</p>
                </div>
              </div>

              <div className="metric-tile">
                <div className="metric-icon-wrap orange">
                  <Cpu size={20} />
                </div>
                <div>
                  <p className="metric-label">Fleet Health</p>
                  <p className="metric-value">{onlineCount}/{instances.length} Online <span style={{ fontSize: '12px', color: 'var(--brand-green-dark)' }}>({runningBackends} Running)</span></p>
                </div>
              </div>
            </section>

            {/* Divided Account Comparison Matrix */}
            <div className="panel" style={{ marginBottom: '24px', padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <p className="panel-kicker" style={{ margin: 0 }}>Divided by Backend</p>
                  <h3 style={{ margin: '4px 0 0 0', fontSize: '16px', fontWeight: 700, color: 'var(--ink)' }}>Account Performance Breakdown</h3>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    className={`filter-tab-pill ${selectedAccount === 'all' ? 'active' : ''}`}
                    onClick={() => setSelectedAccount('all')}
                    style={{ padding: '3px 10px', fontSize: '11px' }}
                  >
                    All Accounts
                  </button>
                  {displayedAccounts.map((acc, i) => (
                    <button
                      key={acc.id}
                      className={`filter-tab-pill ${selectedAccount === String(i) ? 'active' : ''}`}
                      onClick={() => setSelectedAccount(String(i))}
                      style={{ padding: '3px 10px', fontSize: '11px' }}
                    >
                      #{i + 1} {acc.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="table-shell" style={{ border: 'none', borderRadius: 0 }}>
                <table className="client-table">
                  <thead>
                    <tr>
                      <th>Account / Backend</th>
                      <th>Port</th>
                      <th>Clients</th>
                      <th>Primary Ad</th>
                      <th>Ticks</th>
                      <th>Today's Real ($)</th>
                      <th>Lifetime Balance ($)</th>
                      <th>Account Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedAccounts.map((acc, idx) => {
                      if (selectedAccount !== 'all' && selectedAccount !== String(idx)) {
                        return null;
                      }
                      const { url, name: accountName, profile, clients } = acc;
                      const acctTicks = clients.reduce((accTicks, c) => accTicks + (c.ticks || 0), 0);
                      const realToday = profile?.currentTodayUsd ?? 0;
                      const realLifetime = profile?.currentLifetimeUsd ?? 0;
                      const topAd = clients[0]?.adTitle || 'Rotating / Pending';
                      const isBlocked = profile?.blocked === true;

                      return (
                        <tr key={acc.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span className="chip purple" style={{ fontSize: '10px', padding: '2px 6px' }}>#{idx + 1}</span>
                              <strong style={{ color: 'var(--ink)', fontSize: '13px' }}>{accountName}</strong>
                            </div>
                          </td>
                          <td>
                            <span className="cell-code">{url.replace('http://localhost:', ':')}</span>
                          </td>
                          <td className="cell-number">{clients.length}</td>
                          <td style={{ maxWidth: '240px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={topAd}>
                            {topAd}
                          </td>
                          <td className="cell-number">{acctTicks}</td>
                          <td className="cell-money" style={{ fontWeight: 600, color: 'var(--brand-green-dark)' }}>
                            ${realToday.toFixed(6)}
                          </td>
                          <td className="cell-money" style={{ fontWeight: 700, color: 'var(--ink)' }}>
                            ${realLifetime.toFixed(6)}
                          </td>
                          <td>
                            <span className={`chip ${isBlocked ? 'red' : 'green'}`} style={{ fontSize: '11px', padding: '2px 8px' }}>
                              {isBlocked ? 'Blocked' : 'Active (Normal)'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Ad Sponsor Campaign Breakdown */}
            <div className="panel" style={{ marginBottom: '24px', padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <p className="panel-kicker" style={{ margin: 0 }}>Campaign Telemetry</p>
                  <h3 style={{ margin: '4px 0 0 0', fontSize: '16px', fontWeight: 700, color: 'var(--ink)' }}>Active Ad Sponsors ({adPerformanceList.length})</h3>
                </div>
                <span className="panel-count">{allClientsList.length} Total Impressions Rotating</span>
              </div>

              <div className="table-shell" style={{ border: 'none', borderRadius: 0 }}>
                <table className="client-table">
                  <thead>
                    <tr>
                      <th>Sponsor / Ad Campaign</th>
                      <th>Active Clients</th>
                      <th>Total Impressions</th>
                      <th>Paid Bills</th>
                      <th>Conversion</th>
                      <th>Revenue Generated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adPerformanceList.map((ad, aIdx) => {
                      const convRate = ad.ticks > 0 ? ((ad.bills / ad.ticks) * 100).toFixed(1) : '0.0';
                      return (
                        <tr key={aIdx}>
                          <td>
                            <strong style={{ color: 'var(--ink)', fontSize: '13px' }}>{ad.title}</strong>
                          </td>
                          <td className="cell-number">{ad.clientsCount} clients</td>
                          <td className="cell-number">{ad.ticks}</td>
                          <td className="cell-number">{ad.bills}</td>
                          <td>
                            <span className="chip green" style={{ fontSize: '10px', padding: '2px 6px' }}>{convRate}%</span>
                          </td>
                          <td className="cell-money" style={{ fontWeight: 600 }}>${ad.revenue.toFixed(6)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Time-Series Growth Trace Chart */}
            <div className="panel analytics-panel">
              <div className="panel-header">
                <div>
                  <p className="panel-kicker">Time-Series Telemetry</p>
                  <h2>Revenue Growth Trace</h2>
                </div>
                <span className="panel-count">{instances.length} Backend{instances.length === 1 ? '' : 's'}</span>
              </div>
              <p className="panel-description">
                Real-time verified revenue growth trace across active fleet backends.
              </p>

              {historyLoading ? (
                <div className="chart-placeholder">
                  <div className="loading-ring" aria-label="Loading chart" />
                  <span>Loading revenue trace...</span>
                </div>
              ) : (
                <div className="chart-frame">
                  <Suspense
                    fallback={
                      <div className="chart-placeholder">
                        <div className="loading-ring" aria-label="Loading chart renderer" />
                        <span>Initializing chart renderer...</span>
                      </div>
                    }
                  >
                    <MuiLineChart
                      height={380}
                      margin={{ top: 40, right: 24, bottom: 44, left: 70 }}
                      colors={['#00ed64', '#7b3ff2', '#fa6e39', '#3d4f9f', '#003d4f', '#00a35c', '#f06bb8', '#2bb8d8']}
                      series={revenueChart.series}
                      xAxis={[{
                        id: 'time',
                        scaleType: 'point',
                        data: revenueChart.labels,
                        tickLabelStyle: {
                          fill: '#5c6c7a',
                          fontSize: 11,
                          fontFamily: 'Euclid Circular A, Plus Jakarta Sans, sans-serif'
                        }
                      }]}
                      yAxis={[{
                        width: 70,
                        valueFormatter: (value) => {
                          const num = Number(value || 0);
                          if (num === 0) return '$0.000';
                          if (num < 0.01) return `$${num.toFixed(4)}`;
                          return `$${num.toFixed(2)}`;
                        },
                        tickLabelStyle: {
                          fill: '#5c6c7a',
                          fontSize: 11,
                          fontFamily: 'Euclid Circular A, Plus Jakarta Sans, sans-serif'
                        }
                      }]}
                      grid={{ horizontal: true }}
                      axisHighlight={{ x: 'line' }}
                      slotProps={{
                        legend: {
                          direction: 'horizontal',
                          position: { vertical: 'top', horizontal: 'middle' },
                          padding: 0
                        }
                      }}
                      sx={{
                        width: '100%',
                        '& .MuiChartsAxis-line': { stroke: '#e1e5e8' },
                        '& .MuiChartsAxis-tick': { stroke: '#e1e5e8' },
                        '& .MuiChartsGrid-line': { stroke: '#f4f7f6' },
                        '& .MuiChartsLegend-label': {
                          color: '#001e2b',
                          fontSize: 12,
                          fontFamily: 'Euclid Circular A, Plus Jakarta Sans, sans-serif',
                          fontWeight: 600
                        },
                        '& .MuiLineElement-root': { strokeWidth: 2.5 },
                        '& .MuiMarkElement-root': { strokeWidth: 2 }
                      }}
                    />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: CONFIGURATION VIEW */}
        {activeTab === 'config' && (
          <div className="config-layout">
            <div className="panel endpoint-panel">
              <div className="panel-header compact">
                <div>
                  <p className="panel-kicker">Cluster Endpoints</p>
                  <h2>Render API Endpoints</h2>
                </div>
                <span className="panel-count">{instances.length} Total</span>
              </div>

              <div className="endpoint-list">
                {instances.map(url => (
                  <div key={url} className="endpoint-row">
                    <span>{url}</span>
                    <button
                      className="icon-button danger ghost"
                      onClick={() => handleRemoveInstance(url)}
                      disabled={instances.length <= 1}
                      title="Remove endpoint"
                      aria-label={`Remove ${url}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>

              <form onSubmit={handleAddInstance}>
                <div className="form-group">
                  <label htmlFor="newBackendUrl">Add Cluster Endpoint</label>
                  <div className="inline-form">
                    <input
                      id="newBackendUrl"
                      type="text"
                      className="form-input"
                      placeholder="http://localhost:3011"
                      value={newUrl}
                      onChange={e => setNewUrl(e.target.value)}
                    />
                    <button type="submit" className="icon-button primary" title="Add endpoint" aria-label="Add endpoint">
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </form>
            </div>

            <div className="panel config-editor-panel">
              <div className="panel-header compact" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <p className="panel-kicker">Accounts & Fleet</p>
                  <h2>Configured Accounts</h2>
                </div>
                <button
                  type="button"
                  className="btn-primary-pill"
                  style={{ padding: '6px 14px', fontSize: '12px' }}
                  onClick={() => {
                    setAuthStatus('idle');
                    setAuthErrorMsg('');
                    setManualErrorMsg('');
                    setManualSuccessMsg('');
                    setShowConnectModal(true);
                  }}
                >
                  <UserPlus size={13} />
                  <span>+ Connect Account</span>
                </button>
              </div>
              <p className="panel-description">
                Active Kickbacks accounts running in the simulation fleet. Configure client concurrency and humanized prompt wait times per account.
              </p>

              {/* Fleet-Wide Quick Presets */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '10px',
                padding: '12px 16px',
                backgroundColor: 'var(--surface-soft)',
                borderRadius: 'var(--rounded-md)',
                border: '1px solid var(--hairline)',
                marginBottom: '16px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Zap size={14} style={{ color: 'var(--brand-purple)' }} />
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink)' }}>
                    Fleet-Wide Presets:
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--steel)' }}>
                    Quickly calibrate client concurrency & typing pauses across all accounts
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    disabled={fleetPresetLoading}
                    onClick={() => handleApplyFleetPreset({ scale: 5, minPromptWait: 15, maxPromptWait: 30, sessionDuration: 90 })}
                    title="5 clients/account, 15-30s pause, 90s session"
                  >
                    🛡️ Conservative (5 cl)
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    disabled={fleetPresetLoading}
                    onClick={() => handleApplyFleetPreset({ scale: 10, minPromptWait: 8, maxPromptWait: 15, sessionDuration: 60 })}
                    title="10 clients/account, 8-15s pause, 60s session"
                  >
                    ⚖️ Balanced (10 cl)
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    disabled={fleetPresetLoading}
                    onClick={() => handleApplyFleetPreset({ scale: 20, minPromptWait: 5, maxPromptWait: 10, sessionDuration: 45 })}
                    title="20 clients/account, 5-10s pause, 45s session"
                  >
                    ⚡ Turbo (20 cl)
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    disabled={fleetPresetLoading}
                    onClick={() => handleApplyFleetPreset({ scale: 50, minPromptWait: 3, maxPromptWait: 8, sessionDuration: 30 })}
                    title="50 clients/account, 3-8s pause, 30s session"
                  >
                    🚀 Max Load (50 cl)
                  </button>
                </div>
              </div>

              <div style={{ overflowX: 'auto', marginBottom: '24px' }}>
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>Account Name</th>
                      <th>Client ID</th>
                      <th>Clients Scale</th>
                      <th>Random Prompt Wait</th>
                      <th>Session Max</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      try {
                        const parsed = JSON.parse(configJson);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                          return parsed.map(acc => (
                            <tr key={acc.name || acc.clientId}>
                              <td style={{ fontWeight: 600 }}>{acc.name}</td>
                              <td style={{ fontFamily: 'var(--font-code)', fontSize: '12px', color: 'var(--steel)' }}>{acc.clientId || 'N/A'}</td>
                              <td>
                                <span className="chip purple" style={{ fontSize: '11px', padding: '2px 8px' }}>
                                  {acc.scale || 10} clients
                                </span>
                              </td>
                              <td>
                                <span className="chip cyan" style={{ fontSize: '11px', padding: '2px 8px' }}>
                                  <Timer size={10} /> {acc.minPromptWait || 8}s – {acc.maxPromptWait || 15}s
                                </span>
                              </td>
                              <td>
                                <span className="chip neutral" style={{ fontSize: '11px', padding: '2px 8px' }}>
                                  {acc.sessionDuration || 60}s
                                </span>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                                  <button
                                    type="button"
                                    className="btn-card-action"
                                    onClick={() => handleOpenManageAccount(acc)}
                                    title={`Manage clients and timings for ${acc.name}`}
                                    style={{ padding: '3px 10px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px', borderColor: 'rgba(124, 58, 237, 0.35)', color: 'var(--accent-purple)' }}
                                  >
                                    <SlidersHorizontal size={11} /> Manage
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button danger ghost"
                                    onClick={() => handleDeleteAccount(acc.name)}
                                    title="Remove account"
                                    aria-label={`Remove ${acc.name}`}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ));
                        }
                      } catch (_) {}
                      return (
                        <tr>
                          <td colSpan={6} style={{ textAlign: 'center', padding: '16px', color: 'var(--steel)' }}>
                            No accounts configured. Click "+ Connect Account" to log in or add one!
                          </td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>

              <div className="panel-header compact">
                <div>
                  <p className="panel-kicker">Simulator JSON</p>
                  <h2>Fleet Configuration Schema</h2>
                </div>
              </div>
              <p className="panel-description">
                Hot-reloads automatically across all active cluster nodes and synchronizes to local PostgreSQL state.
              </p>

              <form onSubmit={saveConfiguration}>
                <div className="form-group">
                  <textarea
                    className="configurator-textarea"
                    value={configJson}
                    onChange={e => setConfigJson(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn-primary-pill"
                  disabled={configSaving}
                >
                  <Settings size={14} />
                  {configSaving ? 'Synchronizing Cluster...' : 'Save & Hot-Reload Cluster'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* TAB 4: TERMINAL CONSOLE */}
        {activeTab === 'logs' && (
          <div className="console-frame">
            <div className="console-topbar">
              <div className="console-title-area">
                <p className="console-kicker">Cluster Stream</p>
                <h3 className="console-title">Live Simulator Logs</h3>
              </div>

              <div className="console-actions">
                <select
                  className="console-select"
                  value={selectedLogInstance}
                  onChange={e => setSelectedLogInstance(e.target.value)}
                >
                  {instances.map(url => (
                    <option key={url} value={url}>
                      {statuses[url]?.instanceName || url.replace('https://', '')}
                    </option>
                  ))}
                </select>

                <button className="btn-secondary-on-dark" onClick={() => clearInstanceLogs(selectedLogInstance)}>
                  Clear Console
                </button>
              </div>
            </div>

            <div className="console-content">
              {statuses[selectedLogInstance]?.logs?.length === 0 ? (
                <div className="console-row" style={{ color: 'var(--stone)' }}>No logs recorded for this instance yet.</div>
              ) : (
                (statuses[selectedLogInstance]?.logs || []).map((log, idx) => (
                  <div key={idx} className="console-row">
                    <span className="console-time">[{log.time}]</span>
                    <span className={getLogClass(log.message)}>{log.message}</span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}

      </div>

      {/* 5. Footer Region (MongoDB Signature Dark Teal Multi-Column Footer) */}
      <footer className="footer-region">
        <div className="footer-content">
          <div className="footer-left">
            <div className="logo-leaf" style={{ width: 26, height: 26 }}>
              <Cpu size={14} />
            </div>
            <div>
              <span style={{ fontWeight: 600, color: 'var(--ink)' }}>Kickbacks Fleet</span>
              <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--steel)' }}>
                5 Accounts · {allClientsList.length} Active Clients
              </span>
            </div>
          </div>

          <div className="footer-links">
            <button className="footer-link" onClick={() => setActiveTab('dashboard')}>Dashboard</button>
            <button className="footer-link" onClick={() => setActiveTab('analytics')}>Analytics</button>
            <button className="footer-link" onClick={() => setActiveTab('config')}>Config</button>
            <button className="footer-link" onClick={() => setActiveTab('logs')}>Console</button>
          </div>
        </div>
      </footer>

      {/* Connect Account Modal */}
      {showConnectModal && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowConnectModal(false); }}>
          <div className="modal-dialog">
            <div className="modal-header">
              <div>
                <h2>Connect Kickbacks Account</h2>
                <p>Sign in via Google or import an existing refresh token</p>
              </div>
              <button
                className="btn-icon-pill"
                onClick={() => setShowConnectModal(false)}
                title="Close modal"
              >
                <X size={15} />
              </button>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab-btn ${connectTab === 'google' ? 'active' : ''}`}
                onClick={() => setConnectTab('google')}
              >
                <Globe size={13} />
                <span>One-Click Google Login</span>
              </button>
              <button
                className={`modal-tab-btn ${connectTab === 'token' ? 'active' : ''}`}
                onClick={() => setConnectTab('token')}
              >
                <Key size={13} />
                <span>Manual Refresh Token</span>
              </button>
              <button
                className={`modal-tab-btn ${connectTab === 'simulated' ? 'active' : ''}`}
                onClick={() => setConnectTab('simulated')}
              >
                <Sparkles size={13} />
                <span>Simulated Test Bot</span>
              </button>
            </div>

            <div className="modal-body">
              {connectTab === 'google' ? (
                <div>
                  {authStatus === 'idle' && (
                    <div className="google-auth-box">
                      <div className="auth-pulse-ring">
                        <Globe size={22} />
                      </div>
                      <h3 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--ink)' }}>
                        Sign in with Google
                      </h3>
                      <p style={{ fontSize: '13px', color: 'var(--steel)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                        Click below to authenticate with Kickbacks via Google. Terms of Service and Boosted Mode consent scopes are accepted automatically.
                      </p>

                      <div style={{ marginBottom: '18px', textAlign: 'left', background: 'var(--canvas)', padding: '12px 14px', borderRadius: 'var(--rounded-md)', border: '1px solid var(--hairline)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
                            Initial Bot Concurrency:
                          </label>
                          <span className="chip purple" style={{ fontSize: '11px', padding: '1px 8px' }}>
                            {googleScale} Bots
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          {[5, 10, 25, 50].map(cnt => (
                            <button
                              key={cnt}
                              type="button"
                              className={`preset-chip-btn ${googleScale === cnt ? 'active' : ''}`}
                              style={{ flex: 1, justifyContent: 'center', fontSize: '11px', padding: '4px' }}
                              onClick={() => setGoogleScale(cnt)}
                            >
                              {cnt} bots
                            </button>
                          ))}
                        </div>
                      </div>

                      <button
                        type="button"
                        className="btn-primary-pill"
                        style={{ width: '100%', justifyContent: 'center', padding: '10px 20px' }}
                        onClick={handleStartGoogleLogin}
                      >
                        <Globe size={15} />
                        <span>Log in via kickbacks.ai</span>
                      </button>
                    </div>
                  )}

                  {authStatus === 'starting' && (
                    <div style={{ textAlign: 'center', padding: '36px 20px' }}>
                      <div className="loading-ring" style={{ margin: '0 auto 16px auto' }} />
                      <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ink)' }}>Initiating login session...</p>
                    </div>
                  )}

                  {authStatus === 'polling' && (
                    <div className="google-auth-box">
                      <div className="auth-pulse-ring">
                        <RefreshCw size={20} className="spin" />
                      </div>
                      <h3 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 8px 0', color: 'var(--ink)' }}>
                        Waiting for Google Authorization...
                      </h3>
                      <p style={{ fontSize: '13px', color: 'var(--steel)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                        Please complete the sign-in in the newly opened browser window. This dialog will update automatically once verified.
                      </p>
                      {authSession?.loginUrl && (
                        <button
                          type="button"
                          className="btn-outline-pill"
                          style={{ width: '100%', justifyContent: 'center', marginBottom: '10px' }}
                          onClick={() => window.open(authSession.loginUrl, '_blank')}
                        >
                          <ExternalLink size={13} />
                          <span>Re-open Google Sign-In Window</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost-pill"
                        style={{ fontSize: '12px', color: 'var(--steel)' }}
                        onClick={() => setAuthStatus('idle')}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {authStatus === 'success' && (
                    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                      <div style={{
                        width: 52, height: 52, borderRadius: '50%', backgroundColor: 'rgba(16, 185, 129, 0.12)',
                        color: 'var(--accent-green)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto 16px auto'
                      }}>
                        <CheckCircle2 size={26} />
                      </div>
                      <h3 style={{ fontSize: '17px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--ink)' }}>
                        Account Connected Successfully!
                      </h3>
                      <p style={{ fontSize: '13px', color: 'var(--steel)', margin: '0 0 20px 0' }}>
                        Consent scopes were auto-accepted. The simulator fleet has restarted and is actively running with your new account.
                      </p>
                      <button
                        type="button"
                        className="btn-primary-pill"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => setShowConnectModal(false)}
                      >
                        Done & View Dashboard
                      </button>
                    </div>
                  )}

                  {authStatus === 'error' && (
                    <div style={{ textAlign: 'center', padding: '20px 16px' }}>
                      <div style={{
                        width: 48, height: 48, borderRadius: '50%', backgroundColor: 'var(--accent-orange-soft)',
                        color: 'var(--accent-orange)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto 14px auto'
                      }}>
                        <AlertCircle size={24} />
                      </div>
                      <h3 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--ink)' }}>
                        Authentication Failed
                      </h3>
                      <p style={{ fontSize: '13px', color: 'var(--steel)', margin: '0 0 18px 0' }}>
                        {authErrorMsg || 'Unable to complete authorization with Kickbacks.'}
                      </p>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          type="button"
                          className="btn-primary-pill"
                          style={{ flex: 1, justifyContent: 'center' }}
                          onClick={handleStartGoogleLogin}
                        >
                          Try Again
                        </button>
                        <button
                          type="button"
                          className="btn-outline-pill"
                          onClick={() => setAuthStatus('idle')}
                        >
                          Back
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : connectTab === 'token' ? (
                <form onSubmit={handleManualAddAccount}>
                  <div className="form-group" style={{ marginBottom: '14px' }}>
                    <label htmlFor="manualAccountName">Account Name (Optional)</label>
                    <input
                      id="manualAccountName"
                      type="text"
                      className="form-input"
                      placeholder="e.g. account_main"
                      value={manualAccountName}
                      onChange={e => setManualAccountName(e.target.value)}
                    />
                  </div>

                  <div className="form-group" style={{ marginBottom: '14px' }}>
                    <label htmlFor="manualRefreshToken">Refresh Token</label>
                    <input
                      id="manualRefreshToken"
                      type="password"
                      className="form-input"
                      placeholder="Paste your refreshToken here"
                      value={manualRefreshToken}
                      onChange={e => setManualRefreshToken(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group" style={{ marginBottom: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <label htmlFor="manualScale" style={{ margin: 0, fontWeight: 700 }}>Virtual Bots Scale</label>
                      <span className="chip purple" style={{ fontSize: '11px', padding: '1px 8px' }}>
                        {manualScale} Bots
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      {[5, 10, 25, 50].map(cnt => (
                        <button
                          key={cnt}
                          type="button"
                          className={`preset-chip-btn ${manualScale === cnt ? 'active' : ''}`}
                          style={{ flex: 1, justifyContent: 'center', fontSize: '11px', padding: '4px' }}
                          onClick={() => setManualScale(cnt)}
                        >
                          {cnt} bots
                        </button>
                      ))}
                    </div>
                    <input
                      id="manualScale"
                      type="number"
                      min="1"
                      max="100"
                      className="form-input"
                      value={manualScale}
                      onChange={e => setManualScale(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      required
                    />
                  </div>

                  <div className="form-group" style={{ marginBottom: '14px' }}>
                    <label style={{ fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                      Random Prompt Wait Time (Typing Pause)
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div>
                        <label htmlFor="manualMinWait" style={{ fontSize: '11px', color: 'var(--steel)', marginBottom: '2px', display: 'block' }}>Min Wait (s)</label>
                        <input
                          id="manualMinWait"
                          type="number"
                          min="1"
                          max="120"
                          className="form-input"
                          value={manualMinWait}
                          onChange={e => setManualMinWait(e.target.value)}
                        />
                      </div>
                      <div>
                        <label htmlFor="manualMaxWait" style={{ fontSize: '11px', color: 'var(--steel)', marginBottom: '2px', display: 'block' }}>Max Wait (s)</label>
                        <input
                          id="manualMaxWait"
                          type="number"
                          min="1"
                          max="180"
                          className="form-input"
                          value={manualMaxWait}
                          onChange={e => setManualMaxWait(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="form-group" style={{ marginBottom: '20px' }}>
                    <label htmlFor="manualSessionDuration">Session Duration / Max Time (seconds)</label>
                    <input
                      id="manualSessionDuration"
                      type="number"
                      min="15"
                      max="600"
                      className="form-input"
                      value={manualSessionDuration}
                      onChange={e => setManualSessionDuration(e.target.value)}
                    />
                  </div>

                  {manualErrorMsg && (
                    <div className="auth-error" style={{ marginBottom: '16px' }}>{manualErrorMsg}</div>
                  )}

                  {manualSuccessMsg && (
                    <div style={{
                      padding: '10px 14px', backgroundColor: 'rgba(16, 185, 129, 0.1)',
                      color: 'var(--accent-green)', borderRadius: 'var(--rounded-md)',
                      fontSize: '13px', fontWeight: 600, marginBottom: '16px',
                      border: '1px solid rgba(16, 185, 129, 0.25)'
                    }}>
                      {manualSuccessMsg}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn-primary-pill"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={manualSaving}
                  >
                    <Key size={14} />
                    <span>{manualSaving ? 'Verifying & Saving...' : 'Save & Start Simulating'}</span>
                  </button>
                </form>
              ) : (
                /* Simulated Test Bot Tab */
                <form onSubmit={handleCreateSimulatedAccount}>
                  <div style={{
                    padding: '12px 16px',
                    backgroundColor: 'rgba(124, 58, 237, 0.05)',
                    borderRadius: 'var(--rounded-md)',
                    border: '1px solid rgba(124, 58, 237, 0.2)',
                    marginBottom: '16px',
                    fontSize: '13px',
                    color: 'var(--charcoal)',
                    lineHeight: 1.5
                  }}>
                    <strong style={{ color: 'var(--accent-purple)', display: 'block', marginBottom: '2px' }}>
                      ⚡ Zero-Auth Test Bot
                    </strong>
                    Spawns simulated virtual bots locally. Perfect for stress-testing concurrency, bot scaling, and dashboard charts without needing Google credentials.
                  </div>

                  <div className="form-group" style={{ marginBottom: '14px' }}>
                    <label htmlFor="simulatedName">Bot Account Name</label>
                    <input
                      id="simulatedName"
                      type="text"
                      className="form-input"
                      placeholder={`e.g. sim_bot_${displayedAccounts.length + 1}`}
                      value={simulatedName}
                      onChange={e => setSimulatedName(e.target.value)}
                    />
                  </div>

                  <div className="form-group" style={{ marginBottom: '18px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <label htmlFor="simulatedScale" style={{ margin: 0, fontWeight: 700 }}>Number of Virtual Bots</label>
                      <span className="chip purple" style={{ fontSize: '11px', padding: '1px 8px' }}>
                        {simulatedScale} Bots
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      {[5, 10, 25, 50].map(cnt => (
                        <button
                          key={cnt}
                          type="button"
                          className={`preset-chip-btn ${simulatedScale === cnt ? 'active' : ''}`}
                          style={{ flex: 1, justifyContent: 'center', fontSize: '11px', padding: '5px' }}
                          onClick={() => setSimulatedScale(cnt)}
                        >
                          {cnt} bots
                        </button>
                      ))}
                    </div>

                    <input
                      id="simulatedScale"
                      type="number"
                      min="1"
                      max="100"
                      className="form-input"
                      value={simulatedScale}
                      onChange={e => setSimulatedScale(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      required
                    />
                  </div>

                  {simulatedErrorMsg && (
                    <div className="auth-error" style={{ marginBottom: '16px' }}>{simulatedErrorMsg}</div>
                  )}

                  <button
                    type="submit"
                    className="btn-primary-pill"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={simulatedSaving}
                  >
                    <Sparkles size={14} />
                    <span>{simulatedSaving ? 'Spawning Bots...' : `Create Account with ${simulatedScale} Bots`}</span>
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manage Account Concurrency & Timing Modal */}
      {accountToManage && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !manageSaving) setAccountToManage(null); }}>
          <div className="modal-dialog" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <div>
                <h2>Manage Clients & Timing</h2>
                <p>Configure concurrency & humanized rhythm for <strong>{accountToManage.name}</strong></p>
              </div>
              <button
                type="button"
                className="icon-button ghost"
                disabled={manageSaving}
                onClick={() => setAccountToManage(null)}
                aria-label="Close modal"
              >
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              {/* Presets Header Bar */}
              <div style={{ marginBottom: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink)' }}>
                    Quick Presets
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--steel)' }}>
                    Auto-fill settings below
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    style={{ justifyContent: 'center', fontSize: '11px', padding: '6px 4px' }}
                    onClick={() => {
                      setManageScale(5);
                      setManageMinWait(15);
                      setManageMaxWait(30);
                      setManageSessionDuration(90);
                    }}
                  >
                    🛡️ Safe (5)
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    style={{ justifyContent: 'center', fontSize: '11px', padding: '6px 4px' }}
                    onClick={() => {
                      setManageScale(10);
                      setManageMinWait(8);
                      setManageMaxWait(15);
                      setManageSessionDuration(60);
                    }}
                  >
                    ⚖️ Balanced (10)
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    style={{ justifyContent: 'center', fontSize: '11px', padding: '6px 4px' }}
                    onClick={() => {
                      setManageScale(25);
                      setManageMinWait(5);
                      setManageMaxWait(10);
                      setManageSessionDuration(45);
                    }}
                  >
                    ⚡ Turbo (25)
                  </button>
                  <button
                    type="button"
                    className="preset-chip-btn"
                    style={{ justifyContent: 'center', fontSize: '11px', padding: '6px 4px' }}
                    onClick={() => {
                      setManageScale(50);
                      setManageMinWait(3);
                      setManageMaxWait(8);
                      setManageSessionDuration(30);
                    }}
                  >
                    🚀 Max (50)
                  </button>
                </div>
              </div>

              <form onSubmit={handleSaveAccountSettings}>
                {/* Scale Input */}
                <div className="form-group" style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <label htmlFor="manageScaleInput" style={{ margin: 0, fontWeight: 700 }}>
                      Virtual Clients Concurrency
                    </label>
                    <span className="chip purple" style={{ fontSize: '12px', padding: '2px 8px' }}>
                      {manageScale} Active Clients
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="range"
                      min="1"
                      max="50"
                      value={manageScale}
                      onChange={e => setManageScale(parseInt(e.target.value, 10))}
                      style={{ flex: 1, accentColor: 'var(--accent-purple)', cursor: 'pointer' }}
                    />
                    <input
                      id="manageScaleInput"
                      type="number"
                      min="1"
                      max="50"
                      className="form-input"
                      style={{ width: '70px', textAlign: 'center' }}
                      value={manageScale}
                      onChange={e => setManageScale(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)))}
                      required
                    />
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--steel)', marginTop: '4px', display: 'block' }}>
                    Number of parallel simulated developer clients generating ticks for this account.
                  </span>
                </div>

                {/* Prompt Wait Range Inputs */}
                <div className="form-group" style={{ marginBottom: '16px' }}>
                  <label style={{ fontWeight: 700, marginBottom: '6px', display: 'block' }}>
                    Random Prompt Wait Time (Typing Pause)
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <label htmlFor="manageMinWaitInput" style={{ fontSize: '11px', color: 'var(--steel)', marginBottom: '3px', display: 'block' }}>
                        Min Pause (seconds)
                      </label>
                      <input
                        id="manageMinWaitInput"
                        type="number"
                        min="1"
                        max="120"
                        className="form-input"
                        value={manageMinWait}
                        onChange={e => setManageMinWait(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="manageMaxWaitInput" style={{ fontSize: '11px', color: 'var(--steel)', marginBottom: '3px', display: 'block' }}>
                        Max Pause (seconds)
                      </label>
                      <input
                        id="manageMaxWaitInput"
                        type="number"
                        min="1"
                        max="180"
                        className="form-input"
                        value={manageMaxWait}
                        onChange={e => setManageMaxWait(Math.max(1, parseInt(e.target.value, 10) || 1))}
                        required
                      />
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--steel)', marginTop: '4px', display: 'block' }}>
                    After each prompt turn, clients wait a randomized duration between {manageMinWait}s and {manageMaxWait}s before requesting the next ad turn to simulate realistic human developer rhythm.
                  </span>
                </div>

                {/* Session Duration */}
                <div className="form-group" style={{ marginBottom: '18px' }}>
                  <label htmlFor="manageSessionDurationInput" style={{ fontWeight: 700, marginBottom: '4px', display: 'block' }}>
                    Session Duration / Max Time (seconds)
                  </label>
                  <input
                    id="manageSessionDurationInput"
                    type="number"
                    min="15"
                    max="600"
                    className="form-input"
                    value={manageSessionDuration}
                    onChange={e => setManageSessionDuration(Math.max(15, parseInt(e.target.value, 10) || 15))}
                    required
                  />
                  <span style={{ fontSize: '11px', color: 'var(--steel)', marginTop: '4px', display: 'block' }}>
                    Base duration of active simulation work per client before rotating context and refreshing campaign slots.
                  </span>
                </div>

                {/* Apply Fleet-Wide Toggle */}
                <div style={{
                  padding: '10px 14px',
                  backgroundColor: 'var(--surface-soft)',
                  borderRadius: 'var(--rounded-md)',
                  border: '1px solid var(--hairline)',
                  marginBottom: '18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px'
                }}>
                  <input
                    id="manageApplyAllCheckbox"
                    type="checkbox"
                    checked={manageApplyAll}
                    onChange={e => setManageApplyAll(e.target.checked)}
                    style={{ accentColor: 'var(--accent-purple)', cursor: 'pointer', width: 16, height: 16 }}
                  />
                  <label htmlFor="manageApplyAllCheckbox" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', margin: 0 }}>
                    Apply these settings to ALL accounts across the fleet
                  </label>
                </div>

                {manageErrorMsg && (
                  <div className="auth-error" style={{ marginBottom: '14px' }}>{manageErrorMsg}</div>
                )}

                {manageSuccessMsg && (
                  <div style={{
                    padding: '10px 14px',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    color: 'var(--accent-green)',
                    borderRadius: 'var(--rounded-md)',
                    fontSize: '13px',
                    fontWeight: 600,
                    marginBottom: '14px',
                    border: '1px solid rgba(16, 185, 129, 0.25)'
                  }}>
                    {manageSuccessMsg}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    type="button"
                    className="btn-outline-pill"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={manageSaving}
                    onClick={() => setAccountToManage(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-primary-pill"
                    style={{ flex: 2, justifyContent: 'center' }}
                    disabled={manageSaving}
                  >
                    <SlidersHorizontal size={14} />
                    <span>{manageSaving ? 'Applying & Restarting...' : 'Save & Restart Fleet'}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
