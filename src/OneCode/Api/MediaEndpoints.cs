using System.Text.Json;
using OneCode.Infrastructure;

namespace OneCode.Api;

public static class MediaEndpoints
{
    private const int MaxFilesPerRequest = 8;
    private const long MaxBytesPerFile = 10 * 1024 * 1024;

    private static readonly HashSet<string> AllowedImageContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    };

    public static void MapMedia(this WebApplication app)
    {
        var api = app.MapGroup("/api");
        var media = api.MapGroup("/media");
        media.MapPost("/images", UploadImagesAsync);
        media.MapGet("/images/{id}", GetImageAsync);
    }

    private static async Task<IResult> UploadImagesAsync(HttpContext httpContext, CancellationToken cancellationToken)
    {
        if (!httpContext.Request.HasFormContentType)
        {
            return Results.BadRequest(new { message = "Expected multipart/form-data." });
        }

        var form = await httpContext.Request.ReadFormAsync(cancellationToken);
        if (form.Files.Count == 0)
        {
            return Results.BadRequest(new { message = "No files uploaded." });
        }

        if (form.Files.Count > MaxFilesPerRequest)
        {
            return Results.BadRequest(new { message = $"Too many files. Max is {MaxFilesPerRequest}." });
        }

        var imagesRoot = Path.Combine(GetOneCodeDataRoot(), "media", "images");
        Directory.CreateDirectory(imagesRoot);

        var baseUrl = $"{httpContext.Request.Scheme}://{httpContext.Request.Host}";
        var uploaded = new List<UploadedImageDto>();

        foreach (var file in form.Files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (file.Length <= 0)
            {
                continue;
            }

            if (file.Length > MaxBytesPerFile)
            {
                return Results.BadRequest(new { message = $"File too large. Max per file is {MaxBytesPerFile} bytes." });
            }

            var contentType = (file.ContentType ?? string.Empty).Trim();
            if (!AllowedImageContentTypes.Contains(contentType))
            {
                return Results.BadRequest(new { message = $"Unsupported image content-type: {contentType}" });
            }

            var id = Guid.NewGuid().ToString("N");
            var safeFileName = Path.GetFileName(file.FileName ?? string.Empty);
            if (string.IsNullOrWhiteSpace(safeFileName))
            {
                safeFileName = $"{id}.img";
            }

            var blobPath = Path.Combine(imagesRoot, id);
            await using (var outStream = new FileStream(blobPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await file.CopyToAsync(outStream, cancellationToken);
            }

            var meta = new StoredImageMeta(
                Id: id,
                FileName: safeFileName,
                ContentType: contentType,
                SizeBytes: file.Length,
                CreatedAtUtc: DateTimeOffset.UtcNow);

            var metaPath = Path.Combine(imagesRoot, $"{id}.json");
            await File.WriteAllTextAsync(
                metaPath,
                JsonSerializer.Serialize(meta, JsonOptions.DefaultOptions),
                cancellationToken);

            uploaded.Add(new UploadedImageDto(
                Id: id,
                Url: $"{baseUrl}/api/media/images/{id}",
                FileName: safeFileName,
                ContentType: contentType,
                SizeBytes: file.Length));
        }

        if (uploaded.Count == 0)
        {
            return Results.BadRequest(new { message = "No valid image files found in upload." });
        }

        return Results.Json(uploaded, JsonOptions.DefaultOptions);
    }

    private static async Task<IResult> GetImageAsync(HttpContext httpContext, string id, CancellationToken cancellationToken)
    {
        if (!Guid.TryParseExact(id, "N", out _))
        {
            return Results.BadRequest(new { message = "Invalid image id." });
        }

        var imagesRoot = Path.Combine(GetOneCodeDataRoot(), "media", "images");
        var blobPath = Path.Combine(imagesRoot, id);
        if (!File.Exists(blobPath))
        {
            return Results.NotFound();
        }

        var metaPath = Path.Combine(imagesRoot, $"{id}.json");
        StoredImageMeta? meta = null;

        if (File.Exists(metaPath))
        {
            try
            {
                var metaJson = await File.ReadAllTextAsync(metaPath, cancellationToken);
                meta = JsonSerializer.Deserialize<StoredImageMeta>(metaJson, JsonOptions.DefaultOptions);
            }
            catch (Exception ex) when (ex is IOException or JsonException)
            {
                meta = null;
            }
        }

        var contentType = meta?.ContentType ?? "application/octet-stream";
        var fileName = meta?.FileName ?? $"{id}.img";

        return Results.File(blobPath, contentType: contentType, fileDownloadName: fileName);
    }

    private static string GetOneCodeDataRoot()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userProfile, ".one-code");
    }

    private sealed record StoredImageMeta(
        string Id,
        string FileName,
        string ContentType,
        long SizeBytes,
        DateTimeOffset CreatedAtUtc);

    public sealed record UploadedImageDto(
        string Id,
        string Url,
        string FileName,
        string ContentType,
        long SizeBytes);
}
