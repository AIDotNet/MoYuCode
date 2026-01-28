import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * useDebounce - 防抖 Hook
 * 
 * 返回一个防抖后的值，只有在指定延迟后值才会更新
 * 
 * @param value - 需要防抖的值
 * @param delay - 防抖延迟时间（毫秒）
 * @returns 防抖后的值
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

/**
 * useDebouncedCallback - 防抖回调 Hook
 * 
 * 返回一个防抖后的回调函数
 * 
 * @param callback - 需要防抖的回调函数
 * @param delay - 防抖延迟时间（毫秒）
 * @returns 防抖后的回调函数和取消函数
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => unknown>(
  callback: T,
  delay: number
): { debouncedCallback: T; cancel: () => void } {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbackRef = useRef(callback)

  // 保持回调函数最新
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  const cancel = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const debouncedCallback = useCallback(
    ((...args: Parameters<T>) => {
      cancel()
      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args)
      }, delay)
    }) as T,
    [delay, cancel]
  )

  // 清理
  useEffect(() => {
    return cancel
  }, [cancel])

  return { debouncedCallback, cancel }
}

/**
 * useAbortableRequest - 可取消请求 Hook
 * 
 * 提供一个 AbortController 用于取消正在进行的请求
 * 
 * @returns AbortController 和重置函数
 */
export function useAbortableRequest() {
  const abortControllerRef = useRef<AbortController | null>(null)

  const getAbortController = useCallback(() => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    // 创建新的 AbortController
    abortControllerRef.current = new AbortController()
    return abortControllerRef.current
  }, [])

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  // 组件卸载时取消请求
  useEffect(() => {
    return abort
  }, [abort])

  return { getAbortController, abort }
}
