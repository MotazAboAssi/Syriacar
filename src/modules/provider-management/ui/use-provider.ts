"use client";

import { useCallback, useEffect, useState } from "react";
import { providerApi, ProviderApiError } from "../client";
import type { ProviderNotification, ProviderNotificationPage, ProviderProfile, ProviderReferences } from "../contracts";

export type LoadState<T> = { data: T | null; loading: boolean; error: Error | null };
const isSessionFailure = (error: unknown) => error instanceof ProviderApiError && (error.status === 401 || error.status === 403);

export function useProviderLogin() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useCallback(async (phone: string, password: string) => {
    setLoading(true); setError(null);
    try { await providerApi.login(phone, password); return true; }
    catch (error) {
      setError(error instanceof ProviderApiError ? error.message : "تعذّر الاتصال. حاول مجدداً.");
      return false;
    }
    finally { setLoading(false); }
  }, []);
  return { login, loading, error };
}

export function useProviderLogout() {
  const [loading, setLoading] = useState(false);
  const logout = useCallback(async () => {
    setLoading(true);
    try { await providerApi.logout(); } finally { setLoading(false); }
  }, []);
  return { logout, loading };
}

export function useProviderSession() {
  const [state, setState] = useState<LoadState<{ profile: ProviderProfile; references: ProviderReferences }>>({ data: null, loading: true, error: null });
  const [sessionFailed, setSessionFailed] = useState(false);
  const load = useCallback(async () => {
    setSessionFailed(false); setState({ data: null, loading: true, error: null });
    try {
      const [profile, references] = await Promise.all([providerApi.profile(), providerApi.references()]);
      setState({ data: { profile, references }, loading: false, error: null });
    } catch (error) {
      setState({ data: null, loading: false, error: error instanceof Error ? error : new Error("تعذّر تحميل البيانات.") });
      if (isSessionFailure(error)) setSessionFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { ...state, sessionFailed, retry: load };
}

export function useProviderNotifications() {
  const [items, setItems] = useState<ProviderNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const loadPage = useCallback(async (next?: string, append = false) => {
    if (append) setLoadingMore(true); else { setLoading(true); setItems([]); setCursor(null); }
    setError(null); setSessionFailed(false);
    try {
      const page: ProviderNotificationPage = await providerApi.notifications(next);
      setItems(previous => {
        const combined = append ? [...previous, ...page.items] : page.items;
        return combined.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      });
      setCursor(page.nextCursor); setHasLoaded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("تعذّر تحميل الإشعارات."));
      if (isSessionFailure(caught)) { setItems([]); setSessionFailed(true); }
    } finally { setLoading(false); setLoadingMore(false); }
  }, []);
  useEffect(() => { void loadPage(); }, [loadPage]);
  return { items, cursor, loading, loadingMore, error, sessionFailed, hasLoaded, retry: () => loadPage(), loadMore: () => cursor ? loadPage(cursor, true) : undefined };
}

export function useProviderNotification(id: string) {
  const [state, setState] = useState<LoadState<ProviderNotification>>({ data: null, loading: true, error: null });
  const [sessionFailed, setSessionFailed] = useState(false);
  const load = useCallback(async () => {
    setSessionFailed(false); setState({ data: null, loading: true, error: null });
    try { setState({ data: await providerApi.notification(id), loading: false, error: null }); }
    catch (error) {
      setState({ data: null, loading: false, error: error instanceof Error ? error : new Error("تعذّر تحميل الإشعار.") });
      if (isSessionFailure(error)) setSessionFailed(true);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, sessionFailed, retry: load };
}