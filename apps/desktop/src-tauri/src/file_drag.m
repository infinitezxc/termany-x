#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#import <objc/runtime.h>

static NSString *TermanyFileType(NSString *name) {
    // Keep the older type API for our macOS 10.15 deployment target.
    NSString *uti = CFBridgingRelease(UTTypeCreatePreferredIdentifierForTag(kUTTagClassFilenameExtension, (__bridge CFStringRef)name.pathExtension, NULL));
    // Unknown extensions produce non-null dynamic types that AppKit rejects.
    // These promises are files, so directory/package types are unsuitable too.
    if (!uti || UTTypeIsDynamic((__bridge CFStringRef)uti) ||
        !UTTypeConformsTo((__bridge CFStringRef)uti, kUTTypeData)) return @"public.data";
    return uti;
}

// AppKit keeps the pasteboard writer alive for promised writes. Keep its
// delegate with it (NSFilePromiseProvider.delegate itself is weak).
@interface TermanyFileDrag : NSObject <NSFilePromiseProviderDelegate, NSDraggingSource>
@property(nonatomic, copy) NSString *name;
@property(nonatomic, strong) NSURL *source;
@property(nonatomic, strong) NSOperationQueue *queue;
@end

@implementation TermanyFileDrag
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return NSDragOperationCopy;
}
- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session { return YES; }
- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)provider fileNameForType:(NSString *)type { return self.name; }
- (NSOperationQueue *)operationQueueForFilePromiseProvider:(NSFilePromiseProvider *)provider { return self.queue; }
- (void)filePromiseProvider:(NSFilePromiseProvider *)provider writePromiseToURL:(NSURL *)destination completionHandler:(void (^)(NSError *))completion {
    // This is the only network request: AppKit calls it after an accepted drop.
    NSURLSessionDownloadTask *task = [[NSURLSession sharedSession] downloadTaskWithURL:self.source completionHandler:^(NSURL *temporary, NSURLResponse *response, NSError *error) {
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
        if (!error && status != 200) {
            NSString *message = status ? [NSString stringWithFormat:@"Could not download the SSH file (HTTP %ld).", (long)status] : @"Could not download the SSH file: expected an HTTP response.";
            error = [NSError errorWithDomain:@"TermanyFileDrag" code:status ?: 1 userInfo:@{NSLocalizedDescriptionKey: message}];
        }
        if (error) {
            // Avoid logging the source URL: its query includes the remote path/session.
            NSLog(@"[termany] file drag download failed: HTTP %ld, %@ (%ld)", (long)status, error.domain, (long)error.code);
            completion(error);
            return;
        }
        // AppKit already coordinates the promised destination until completion.
        // A second coordinator on this URLSession callback thread deadlocks
        // against that outstanding claim, leaving Finder waiting forever.
        // Move before returning: URLSession then removes its temporary file.
        NSError *writeError = nil;
        // Never replace an existing destination. Finder resolves name conflicts.
        [[NSFileManager defaultManager] moveItemAtURL:temporary toURL:destination error:&writeError];
        if (writeError) NSLog(@"[termany] file drag write failed: %@ (%ld): %@", writeError.domain, (long)writeError.code, writeError.localizedDescription);
        completion(writeError);
    }];
    [task resume];
}
@end

// Runs on AppKit's main thread. No file bytes are read here.
int termany_start_file_drag(void *viewPointer, const char *nameBytes, const char *sourceBytes, bool remote) {
    @autoreleasepool {
        NSView *view = (__bridge NSView *)viewPointer;
        if (!view.window || !(NSEvent.pressedMouseButtons & 1)) return 1;
        NSString *name = [NSString stringWithUTF8String:nameBytes];
        NSString *source = [NSString stringWithUTF8String:sourceBytes];
        TermanyFileDrag *delegate = [TermanyFileDrag new];
        delegate.name = name;
        delegate.queue = [NSOperationQueue new];
        delegate.queue.maxConcurrentOperationCount = 1;
        id<NSPasteboardWriting> writer;
        if (remote) {
            delegate.source = [NSURL URLWithString:source];
            if (!delegate.source) return 2;
            NSFilePromiseProvider *provider = [[NSFilePromiseProvider alloc] initWithFileType:TermanyFileType(name) delegate:delegate];
            objc_setAssociatedObject(provider, @selector(fileNameForType:), delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            writer = provider;
        } else {
            if (![[NSFileManager defaultManager] fileExistsAtPath:source]) return 3;
            writer = [NSURL fileURLWithPath:source];
        }
        NSPoint point = [view.window mouseLocationOutsideOfEventStream];
        NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:view.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
        NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:writer];
        NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFileType:name.pathExtension];
        NSPoint local = [view convertPoint:point fromView:nil];
        [item setDraggingFrame:NSMakeRect(local.x - 16, local.y - 16, 32, 32) contents:icon];
        NSDraggingSession *session = [view beginDraggingSessionWithItems:@[item] event:event source:delegate];
        objc_setAssociatedObject(session, @selector(ignoreModifierKeysForDraggingSession:), delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return 0;
    }
}
