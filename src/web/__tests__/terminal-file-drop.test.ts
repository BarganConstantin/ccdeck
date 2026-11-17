import { describe, expect, it } from 'vitest';
import { fileDropText, isFileDrop, quoteDroppedPaths } from '../terminal-file-drop';

describe('native terminal file drops', () => {
  it('quotes multiple Unix paths without executing shell syntax or submitting a line', () => {
    const result = quoteDroppedPaths(['/tmp/My report.pdf', "/tmp/O'Brien $(whoami);.txt"], 'MacIntel');
    expect(result).toBe("'/tmp/My report.pdf' '/tmp/O'\\''Brien $(whoami);.txt' ");
    expect(result).not.toContain('\n');
  });
  it('uses PowerShell literal quoting for Windows paths', () => {
    expect(quoteDroppedPaths(["C:\\Users\\Example\\O'Brien.txt"], 'Win32')).toBe("'C:\\Users\\Example\\O''Brien.txt' ");
  });
  it.each([[], ['relative.txt'], ['/tmp/bad\ncommand'], ['/tmp/bad\rcommand'], ['/tmp/bad\u0000file'], Array(65).fill('/tmp/file')].map(paths => [paths]))('refuses invalid paths or an oversized drop', paths => {
    expect(quoteDroppedPaths(paths, 'MacIntel')).toBeNull();
  });
  it('keeps session drags separate and requires all native file paths', () => {
    expect(isFileDrop({ types: ['application/ccdeck-session'] })).toBe(false);
    expect(isFileDrop({ types: ['Files'] })).toBe(true);
    const files = [new File(['fixture'], 'report.txt')];
    expect(fileDropText({ files } as unknown as DataTransfer, 'MacIntel', () => ['/tmp/report.txt'])).toBe("'/tmp/report.txt' ");
    expect(fileDropText({ files } as unknown as DataTransfer, 'MacIntel', () => [''])).toBeNull();
    expect(fileDropText({ files } as unknown as DataTransfer, 'MacIntel', () => [])).toBeNull();
    expect(fileDropText({ files } as unknown as DataTransfer, 'MacIntel', () => { throw Error('unavailable'); })).toBeNull();
  });
});
