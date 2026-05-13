/**
 * Logger utility for the Semantic Search plugin
 * Uses ZoteroToolkit for enhanced logging
 */

import { BasicTool } from 'zotero-plugin-toolkit';

declare const Zotero: any;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private prefix: string;
  private debugEnabled: boolean;
  private ztoolkit: BasicTool;

  constructor(prefix: string) {
    // Always emit a stable `[ZotSeek:<module>]` prefix so log filters can
    // catch every ZotSeek-internal module by matching `[ZotSeek`. The plain
    // `ZotSeek` tag is treated as the root module and rendered as just
    // `[ZotSeek]` for backward compatibility with existing log greps.
    this.prefix = prefix === 'ZotSeek' ? '[ZotSeek]' : `[ZotSeek:${prefix}]`;
    this.debugEnabled = true; // TODO: Read from preferences

    // Initialize ZoteroToolkit for this logger
    this.ztoolkit = new BasicTool();
    this.ztoolkit.basicOptions.log.prefix = this.prefix;
    this.ztoolkit.basicOptions.log.disableConsole = false;
  }

  private log(level: string, ...args: any[]): void {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    // Use toolkit's log method
    this.ztoolkit.log(`[${level.toUpperCase()}] ${message}`);
    
    // For errors, also log to Zotero.logError for visibility
    if (level === 'error' && typeof Zotero !== 'undefined' && Zotero.logError) {
      Zotero.logError(new Error(`${this.prefix} ${message}`));
    }
  }

  debug(...args: any[]): void {
    if (!this.debugEnabled) return;
    this.log('debug', ...args);
  }

  info(...args: any[]): void {
    this.log('info', ...args);
  }

  warn(...args: any[]): void {
    this.log('warn', ...args);
  }

  error(...args: any[]): void {
    this.log('error', ...args);
  }
  
  /**
   * Log an object with pretty printing
   */
  logObject(label: string, obj: any): void {
    this.ztoolkit.log(`${label}:`, obj);
  }
  
  /**
   * Get the Zotero object via toolkit
   */
  getGlobal(name: string): any {
    return this.ztoolkit.getGlobal(name);
  }

  /**
   * Set debug mode
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }
}

