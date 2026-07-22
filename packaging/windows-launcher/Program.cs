using System.Diagnostics;

var baseDirectory = AppContext.BaseDirectory;
var runtime = Path.Combine(baseDirectory, "runtime", "node.exe");
var application = Path.Combine(baseDirectory, "app.mjs");

if (!File.Exists(runtime) || !File.Exists(application))
{
    Console.Error.WriteLine("Secure Host MCP package is incomplete: runtime/node.exe or app.mjs is missing.");
    return 2;
}

try
{
    var startInfo = new ProcessStartInfo(runtime) { UseShellExecute = false };
    startInfo.ArgumentList.Add(application);
    if (args.Length == 0)
    {
        startInfo.ArgumentList.Add("launch");
    }
    else
    {
        foreach (var argument in args) startInfo.ArgumentList.Add(argument);
    }

    using var child = Process.Start(startInfo);
    if (child is null)
    {
        Console.Error.WriteLine("Secure Host MCP failed to start its embedded Node.js runtime.");
        return 3;
    }
    child.WaitForExit();
    return child.ExitCode;
}
catch (Exception error)
{
    Console.Error.WriteLine($"Secure Host MCP failed to start: {error.Message}");
    return 1;
}
