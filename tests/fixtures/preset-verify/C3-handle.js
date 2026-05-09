function handle(cmd) {
  switch (cmd) {
    case 'add':
      return 1;
    case 'sub':
      return 2;
    case 'mul':
      return 3;
    case 'div':
      return 4;
    default:
      return 0;
  }
}
