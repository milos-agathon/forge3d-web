param(
  [Parameter(Mandatory = $true)]
  [string]$JobsRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Forge3DInteractiveSession {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public Int32 cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public Int32 dwX;
    public Int32 dwY;
    public Int32 dwXSize;
    public Int32 dwYSize;
    public Int32 dwXCountChars;
    public Int32 dwYCountChars;
    public Int32 dwFillAttribute;
    public Int32 dwFlags;
    public Int16 wShowWindow;
    public Int16 cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public Int32 dwProcessId;
    public Int32 dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public Int64 Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public Int64 TotalUserTime;
    public Int64 TotalKernelTime;
    public Int64 ThisPeriodTotalUserTime;
    public Int64 ThisPeriodTotalKernelTime;
    public UInt32 TotalPageFaultCount;
    public UInt32 TotalProcesses;
    public UInt32 ActiveProcesses;
    public UInt32 TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll")]
  public static extern UInt32 WTSGetActiveConsoleSessionId();
  [DllImport("Wtsapi32.dll", SetLastError = true)]
  public static extern bool WTSQueryUserToken(
    UInt32 sessionId,
    out IntPtr token
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool DuplicateTokenEx(
    IntPtr existingToken,
    UInt32 desiredAccess,
    IntPtr tokenAttributes,
    Int32 impersonationLevel,
    Int32 tokenType,
    out IntPtr primaryToken
  );

  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool CreateEnvironmentBlock(
    out IntPtr environment,
    IntPtr token,
    bool inherit
  );

  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool DestroyEnvironmentBlock(IntPtr environment);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessAsUser(
    IntPtr token,
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    UInt32 creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UInt32 WaitForSingleObject(
    IntPtr handle,
    UInt32 milliseconds
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(
    IntPtr process,
    out UInt32 exitCode
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(
    IntPtr jobAttributes,
    string name
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(
    IntPtr job,
    Int32 informationClass,
    IntPtr information,
    UInt32 informationLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(
    IntPtr job,
    IntPtr process
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(
    IntPtr job,
    UInt32 exitCode
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(
    IntPtr job,
    Int32 informationClass,
    IntPtr information,
    UInt32 informationLength,
    out UInt32 returnLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(
    IntPtr process,
    UInt32 exitCode
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UInt32 ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@
function Assert-Win32 {
  param([bool]$Success, [string]$Operation)
  if (-not $Success) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "$Operation failed with Win32 error $code"
  }
}

function Wait-JobObjectEmpty {
  param([IntPtr]$Job, [int]$TimeoutMilliseconds = 5000)
  $accounting =
    New-Object Forge3DInteractiveSession+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
  $size = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  try {
    while ($true) {
      $returned = [UInt32]0
      Assert-Win32 (
        [Forge3DInteractiveSession]::QueryInformationJobObject(
          $Job,
          1,
          $pointer,
          $size,
          [ref]$returned
        )
      ) "QueryInformationJobObject"
      $accounting = [Runtime.InteropServices.Marshal]::PtrToStructure(
        $pointer,
        [Forge3DInteractiveSession+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION]
      )
      if ($accounting.ActiveProcesses -eq 0) {
        return
      }
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "interactive runner Job Object remained active after termination"
      }
      Start-Sleep -Milliseconds 50
    }
  }
  finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
  }
}

function Read-EnvironmentBlock {
  param([IntPtr]$Pointer)
  $result = @{}
  $offset = 0
  while ($true) {
    $entry = [Runtime.InteropServices.Marshal]::PtrToStringUni(
      [IntPtr]::Add($Pointer, $offset)
    )
    if ([string]::IsNullOrEmpty($entry)) {
      break
    }
    $separator = $entry.IndexOf("=")
    if ($separator -gt 0) {
      $result[$entry.Substring(0, $separator)] = $entry.Substring($separator + 1)
    }
    $offset += ($entry.Length + 1) * 2
  }
  return $result
}

function New-EnvironmentBlock {
  param([hashtable]$Environment)
  $entries = $Environment.GetEnumerator() |
    Sort-Object -Property Name |
    ForEach-Object { "$($_.Name)=$($_.Value)" }
  $characters = (($entries -join "`0") + "`0`0").ToCharArray()
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal(
    $characters.Length * 2
  )
  [Runtime.InteropServices.Marshal]::Copy(
    $characters,
    0,
    $pointer,
    $characters.Length
  )
  return $pointer
}
$requestText = [Console]::In.ReadToEnd()
$request = $requestText | ConvertFrom-Json
if (
  $request.schemaVersion -ne 1 -or
  $request.command -ne "run.cmd" -or
  $request.arguments.Count -ne 2 -or
  $request.arguments[0] -ne "--jitconfig" -or
  $request.arguments[1] -notmatch "^[A-Za-z0-9_+/=-]{20,}$"
) {
  throw "interactive-session launch request violates the fixed runner contract"
}

$jobsRootPath = [IO.Path]::GetFullPath($JobsRoot).TrimEnd("\")
$workingPath = [IO.Path]::GetFullPath([string]$request.workingDirectory)
$jobsPrefix = "$jobsRootPath\"
if (
  -not $workingPath.StartsWith(
    $jobsPrefix,
    [StringComparison]::OrdinalIgnoreCase
  ) -or
  [IO.Path]::GetFileName($workingPath) -ne "runner"
) {
  throw "interactive-session working directory escapes the controller jobs root"
}
$runnerPath = Join-Path $workingPath "run.cmd"
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw "checked Windows runner entrypoint is missing"
}

$sessionId = [Forge3DInteractiveSession]::WTSGetActiveConsoleSessionId()
if ($sessionId -eq [UInt32]::MaxValue) {
  throw "no active physical console session is available"
}
$locked = Get-Process -Name "LogonUI" -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq $sessionId }
if ($null -ne $locked) {
  throw "active physical console session is locked"
}

$userToken = [IntPtr]::Zero
$primaryToken = [IntPtr]::Zero
$userEnvironment = [IntPtr]::Zero
$mergedEnvironment = [IntPtr]::Zero
$jobInformation = [IntPtr]::Zero
$jobHandle = [IntPtr]::Zero
$processInformation =
  New-Object Forge3DInteractiveSession+PROCESS_INFORMATION
$launchReceiptWritten = $false
$assignedToJob = $false
try {
  Assert-Win32 (
    [Forge3DInteractiveSession]::WTSQueryUserToken($sessionId, [ref]$userToken)
  ) "WTSQueryUserToken"
  $tokenAccess = 0x0001 -bor 0x0002 -bor 0x0008 -bor 0x0080 -bor 0x0100
  Assert-Win32 (
    [Forge3DInteractiveSession]::DuplicateTokenEx(
      $userToken,
      $tokenAccess,
      [IntPtr]::Zero,
      2,
      1,
      [ref]$primaryToken
    )
  ) "DuplicateTokenEx"
  Assert-Win32 (
    [Forge3DInteractiveSession]::CreateEnvironmentBlock(
      [ref]$userEnvironment,
      $primaryToken,
      $false
    )
  ) "CreateEnvironmentBlock"

  $environment = Read-EnvironmentBlock $userEnvironment
  foreach ($property in $request.environment.PSObject.Properties) {
    $name = [string]$property.Name
    $value = [string]$property.Value
    $forwarded = $name -match "^(PATH|LANG)$" -or
      $name -match "^FORGE3D_(BROWSER|UPDATE|PLAYWRIGHT|GECKODRIVER|APPIUM|DEVICE|CLOUDFLARED|WDA)_"
    $derived = $name -match "^(HOME|USERPROFILE|SystemRoot|WINDIR|ComSpec|PATHEXT|TMP|TEMP|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|XDG_SESSION_ID|XDG_SESSION_TYPE)$"
    if ((-not $forwarded -and -not $derived) -or $value.IndexOf([char]0) -ge 0) {
      throw "interactive-session environment contains a prohibited entry"
    }
    if ($forwarded) {
      $environment[$name] = $value
    }
  }
  $mergedEnvironment = New-EnvironmentBlock $environment

  $comspec = [Environment]::GetEnvironmentVariable("ComSpec")
  if ([string]::IsNullOrWhiteSpace($comspec)) {
    $comspec = Join-Path $env:SystemRoot "System32\cmd.exe"
  }
  $jitConfiguration = [string]$request.arguments[1]
  $commandLineText =
    '"' + $comspec + '" /d /s /c ""' +
    $runnerPath + '" --jitconfig "' + $jitConfiguration + '""'
  $commandLine = New-Object Text.StringBuilder(
    $commandLineText
  )
  $startupInfo = New-Object Forge3DInteractiveSession+STARTUPINFO
  $startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf($startupInfo)
  $startupInfo.lpDesktop = "winsta0\default"
  $jobHandle = [Forge3DInteractiveSession]::CreateJobObject(
    [IntPtr]::Zero,
    $null
  )
  if ($jobHandle -eq [IntPtr]::Zero) {
    Assert-Win32 $false "CreateJobObject"
  }
  $jobLimits =
    New-Object Forge3DInteractiveSession+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $basicLimits =
    New-Object Forge3DInteractiveSession+JOBOBJECT_BASIC_LIMIT_INFORMATION
  $basicLimits.LimitFlags = 0x00002000
  $jobLimits.BasicLimitInformation = $basicLimits
  $jobInformationSize =
    [Runtime.InteropServices.Marshal]::SizeOf($jobLimits)
  $jobInformation =
    [Runtime.InteropServices.Marshal]::AllocHGlobal($jobInformationSize)
  [Runtime.InteropServices.Marshal]::StructureToPtr(
    $jobLimits,
    $jobInformation,
    $false
  )
  Assert-Win32 (
    [Forge3DInteractiveSession]::SetInformationJobObject(
      $jobHandle,
      9,
      $jobInformation,
      $jobInformationSize
    )
  ) "SetInformationJobObject"
  Assert-Win32 (
    [Forge3DInteractiveSession]::CreateProcessAsUser(
      $primaryToken,
      $comspec,
      $commandLine,
      [IntPtr]::Zero,
      [IntPtr]::Zero,
      $false,
      0x00000404,
      $mergedEnvironment,
      $workingPath,
      [ref]$startupInfo,
      [ref]$processInformation
    )
  ) "CreateProcessAsUser"
  Assert-Win32 (
    [Forge3DInteractiveSession]::AssignProcessToJobObject(
      $jobHandle,
      $processInformation.hProcess
    )
  ) "AssignProcessToJobObject"
  $assignedToJob = $true
  $resumeResult = [Forge3DInteractiveSession]::ResumeThread(
    $processInformation.hThread
  )
  if ($resumeResult -eq [UInt32]::MaxValue) {
    Assert-Win32 $false "ResumeThread"
  }

  @{
    schemaVersion = 1
    processId = $processInformation.dwProcessId
    consoleSessionId = $sessionId
    desktop = "winsta0\default"
  } | ConvertTo-Json -Compress | Write-Output
  [Console]::Out.Flush()
  $launchReceiptWritten = $true

  $waitResult = [Forge3DInteractiveSession]::WaitForSingleObject(
    $processInformation.hProcess,
    [UInt32]::MaxValue
  )
  if ($waitResult -ne 0) {
    throw "interactive runner wait failed: $waitResult"
  }
  $exitCode = [UInt32]0
  Assert-Win32 (
    [Forge3DInteractiveSession]::GetExitCodeProcess(
      $processInformation.hProcess,
      [ref]$exitCode
    )
  ) "GetExitCodeProcess"
  exit [int]$exitCode
}
catch {
  if ($processInformation.hProcess -ne [IntPtr]::Zero) {
    if ($assignedToJob) {
      Assert-Win32 (
        [Forge3DInteractiveSession]::TerminateJobObject($jobHandle, 1)
      ) "TerminateJobObject"
    } else {
      Assert-Win32 (
        [Forge3DInteractiveSession]::TerminateProcess(
          $processInformation.hProcess,
          1
        )
      ) "TerminateProcess"
    }
    $cleanupWait = [Forge3DInteractiveSession]::WaitForSingleObject(
      $processInformation.hProcess,
      5000
    )
    if ($cleanupWait -ne 0) {
      throw "interactive runner tree remained present after failed launch: $cleanupWait"
    }
    if ($assignedToJob) {
      Wait-JobObjectEmpty $jobHandle
    }
  }
  if (-not $launchReceiptWritten) {
    @{
      schemaVersion = 1
      recordType = "launch_cleanup"
      processStarted = $processInformation.hProcess -ne [IntPtr]::Zero
      processId = if ($processInformation.hProcess -ne [IntPtr]::Zero) {
        $processInformation.dwProcessId
      } else {
        $null
      }
      stopped = $true
      observedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress | Write-Output
    [Console]::Out.Flush()
  }
  throw
}
finally {
  if ($processInformation.hThread -ne [IntPtr]::Zero) {
    [void][Forge3DInteractiveSession]::CloseHandle($processInformation.hThread)
  }
  if ($processInformation.hProcess -ne [IntPtr]::Zero) {
    [void][Forge3DInteractiveSession]::CloseHandle($processInformation.hProcess)
  }
  if ($jobHandle -ne [IntPtr]::Zero) {
    [void][Forge3DInteractiveSession]::CloseHandle($jobHandle)
  }
  if ($jobInformation -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($jobInformation)
  }
  if ($mergedEnvironment -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($mergedEnvironment)
  }
  if ($userEnvironment -ne [IntPtr]::Zero) {
    [void][Forge3DInteractiveSession]::DestroyEnvironmentBlock($userEnvironment)
  }
  if ($primaryToken -ne [IntPtr]::Zero) {
    [void][Forge3DInteractiveSession]::CloseHandle($primaryToken)
  }
  if ($userToken -ne [IntPtr]::Zero) {
    [void][Forge3DInteractiveSession]::CloseHandle($userToken)
  }
}
