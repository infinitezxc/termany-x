#import "../src-tauri/src/file_drag.m"

// Exercise the real promise delegate without opening a window or Finder.
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 4) return 2;
        TermanyFileDrag *delegate = [TermanyFileDrag new];
        delegate.name = @"report 雪.bin";
        delegate.source = [NSURL URLWithString:[NSString stringWithUTF8String:argv[1]]];
        delegate.queue = [NSOperationQueue new];
        for (NSString *name in @[@"README", @".gitignore", @"report.termanyunknown123", @"regular.app", @"report.txt"]) {
            NSString *type = TermanyFileType(name);
            NSString *expected = [name isEqualToString:@"report.txt"] ? @"public.plain-text" : @"public.data";
            if (![type isEqualToString:expected]) return 6;
            // Construct the actual AppKit provider to catch rejected UTIs.
            NSFilePromiseProvider *typed = [[NSFilePromiseProvider alloc] initWithFileType:type delegate:delegate];
            if (![typed.fileType isEqualToString:expected]) return 7;
        }
        NSFilePromiseProvider *provider = [[NSFilePromiseProvider alloc] initWithFileType:@"public.data" delegate:delegate];
        if (![[delegate filePromiseProvider:provider fileNameForType:@"public.data"] isEqualToString:delegate.name]) return 3;
        if ([delegate draggingSession:nil sourceOperationMaskForDraggingContext:NSDraggingContextOutsideApplication] != NSDragOperationCopy) return 4;
        // A cancelled drag only asks for metadata. It must never fetch bytes.
        if (strcmp(argv[3], "cancel") == 0) return 0;
        NSURL *destination = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block BOOL failed = NO;
        // AppKit holds a coordinated write until promise completion. Calling
        // the delegate directly misses deadlocks caused by a second coordinator.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSError *coordinationError = nil;
            NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
            [coordinator coordinateWritingItemAtURL:destination options:NSFileCoordinatorWritingForReplacing error:&coordinationError byAccessor:^(NSURL *url) {
                dispatch_semaphore_t written = dispatch_semaphore_create(0);
                [delegate filePromiseProvider:provider writePromiseToURL:url completionHandler:^(NSError *error) {
                    failed = error != nil;
                    if (error) fprintf(stderr, "completion: %s\n", error.localizedDescription.UTF8String);
                    dispatch_semaphore_signal(written);
                }];
                dispatch_semaphore_wait(written, DISPATCH_TIME_FOREVER);
            }];
            failed = failed || coordinationError != nil;
            dispatch_semaphore_signal(done);
        });
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
        while (dispatch_semaphore_wait(done, DISPATCH_TIME_NOW) != 0) {
            if (deadline.timeIntervalSinceNow < 0) return 5;
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
        return failed ? 1 : 0;
    }
}
