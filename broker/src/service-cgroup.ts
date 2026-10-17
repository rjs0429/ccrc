import fs from "node:fs";

// Commands Claude runs in a broker session are children of the broker, in the ccrc.service cgroup: restarting or
// stopping the service stops them too, halfway. Commands that do either refuse to run there.

function ownCgroup(): string {
  try {
    return fs.readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

export function inBrokerService(cgroup = ownCgroup()): boolean {
  return cgroup.split("\n").some((line) => /\/ccrc\.service(\/|$)/.test(line.trim()));
}

export function inServiceRefusal(command: string): string {
  return `ccrc ${command} restarts or stops ccrc.service, and this runs inside it (a session the broker started, such as one from the phone), so it would be stopped halfway. Run it in a terminal on the machine, or in VS Code's terminal.`;
}
